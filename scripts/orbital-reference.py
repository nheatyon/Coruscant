"""Independent verification only: fresh supplied OMMs, Python sgp4, separate frame math.

No sample fixtures, provider calls, source assets or application database access.
Requires the reviewed sgp4==2.27 in an isolated Python 3.12 environment.
"""
import datetime as dt
import json
import math
import sys
from importlib.metadata import version

from sgp4 import omm
from sgp4.api import Satrec, WGS72, accelerated, jday


def sidereal(julian):
    centuries = (julian - 2451545.0) / 36525.0
    seconds = (67310.54841 + (876600.0 * 3600 + 8640184.812866) * centuries
               + 0.093104 * centuries ** 2 - 6.2e-6 * centuries ** 3)
    return (seconds * math.pi / 43200.0) % (2 * math.pi)


def observer(latitude, longitude):
    phi, lam = math.radians(latitude), math.radians(longitude)
    a, flattening = 6378.137, 1 / 298.257223563
    eccentricity2 = flattening * (2 - flattening)
    normal = a / math.sqrt(1 - eccentricity2 * math.sin(phi) ** 2)
    up = [math.cos(phi) * math.cos(lam), math.cos(phi) * math.sin(lam), math.sin(phi)]
    return [normal * up[0], normal * up[1], normal * (1 - eccentricity2) * up[2]], up


def geodetic(point):
    a, flattening = 6378.137, 1 / 298.257223563
    b = a * (1 - flattening)
    e2 = flattening * (2 - flattening)
    ep2 = (a * a - b * b) / (b * b)
    x, y, z = point
    horizontal = math.hypot(x, y)
    if horizontal < 1e-12:
        return [math.copysign(90, z), 0, abs(z) - b]
    # Bowring starting value, followed by a bounded latitude correction.
    theta = math.atan2(z * a, horizontal * b)
    phi = math.atan2(z + ep2 * b * math.sin(theta) ** 3,
                     horizontal - e2 * a * math.cos(theta) ** 3)
    for _ in range(8):
        normal = a / math.sqrt(1 - e2 * math.sin(phi) ** 2)
        phi = math.atan2(z + e2 * normal * math.sin(phi), horizontal)
    normal = a / math.sqrt(1 - e2 * math.sin(phi) ** 2)
    height = horizontal / math.cos(phi) - normal
    return [math.degrees(phi), math.degrees(math.atan2(y, x)), height]


assert version('sgp4') == '2.27', 'Use the approved exact verification version.'
request = json.load(sys.stdin)
results = []
for record in request['records']:
    fields = dict(record['omm'])
    # Application and oracle deliberately use the same declared millisecond epoch.
    fields['EPOCH'] = fields['EPOCH'].removesuffix('Z')
    satellite = Satrec()
    omm.initialize(satellite, fields, WGS72)  # package API: improved mode, no fixture import
    for instant in record['instants']:
        date = dt.datetime.fromisoformat(instant.replace('Z', '+00:00'))
        day, fraction = jday(date.year, date.month, date.day, date.hour, date.minute,
                             date.second + date.microsecond / 1_000_000)
        error, position, velocity = satellite.sgp4(day, fraction)
        if error:
            results.append({'id': record['id'], 'at': instant, 'error': error})
            continue
        angle = sidereal(day + fraction)
        c, s = math.cos(angle), math.sin(angle)
        fixed = [c * position[0] + s * position[1],
                 -s * position[0] + c * position[1], position[2]]
        elevations = []
        for coordinates in request['observers']:
            origin, up = observer(*coordinates)
            line = [fixed[i] - origin[i] for i in range(3)]
            vertical = sum(line[i] * up[i] for i in range(3))
            squared = sum(component * component for component in line)
            elevations.append(math.degrees(math.atan2(vertical, math.sqrt(max(0, squared - vertical * vertical)))))
        results.append({'id': record['id'], 'at': instant, 'error': 0,
                        'position': position, 'velocity': velocity, 'ecf': fixed,
                        'geodetic': geodetic(fixed), 'elevations': elevations})
json.dump({'sgp4Version': version('sgp4'), 'accelerated': accelerated,
           'method': 'WGS72/improved; TEME; UT1≈UTC/zero EOP; WGS84 height-zero observer',
           'results': results}, sys.stdout, allow_nan=False)
