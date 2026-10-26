"""Independent numerical checks against explicitly supplied fresh OMM bytes.

Verification only, not an application kernel or downloaded fixture. Python sgp4
is separately installed at the approved exact version. LOS uses a dense 1 s grid
and finer reference refinement; solar direction follows the cited USNO formula.
"""
import datetime as dt
import json
import math
import sys
from importlib.metadata import version
from sgp4 import omm
from sgp4.api import Satrec, WGS72, jday

RAD = math.pi / 180


def epoch_ms(value):
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000


def utc(value):
    return dt.datetime.fromtimestamp(value / 1000, dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def julian(value):
    date = dt.datetime.fromtimestamp(value / 1000, dt.timezone.utc)
    return jday(date.year, date.month, date.day, date.hour, date.minute, date.second + date.microsecond / 1e6)


def sidereal(jd):
    t = (jd - 2451545) / 36525
    seconds = 67310.54841 + (876600 * 3600 + 8640184.812866) * t + .093104 * t ** 2 - 6.2e-6 * t ** 3
    return seconds * math.pi / 43200 % (2 * math.pi)


def observer(lat, lon):
    phi, lam = lat * RAD, lon * RAD
    e2 = (1 / 298.257223563) * (2 - 1 / 298.257223563)
    n = 6378.137 / math.sqrt(1 - e2 * math.sin(phi) ** 2)
    up = [math.cos(phi) * math.cos(lam), math.cos(phi) * math.sin(lam), math.sin(phi)]
    return [n * up[0], n * up[1], n * (1 - e2) * up[2]], up


def ground_distance(lat, lon, other_lat, other_lon):
    # Independent haversine, rather than the application dot/cross expression.
    p, q = lat * RAD, other_lat * RAD
    a = math.sin((q - p) / 2) ** 2 + math.cos(p) * math.cos(q) * math.sin((other_lon - lon) * RAD / 2) ** 2
    a = min(1, max(0, a))
    return 2 * 6371.0088 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def sun_elevation(value, lat, lon):
    day, fraction = julian(value)
    d = day + fraction - 2451545
    g = (357.529 + .98560028 * d) * RAD
    q = 280.459 + .98564736 * d
    longitude = (q + 1.915 * math.sin(g) + .020 * math.sin(2 * g)) * RAD
    obliquity = (23.439 - .00000036 * d) * RAD
    ra = math.atan2(math.cos(obliquity) * math.sin(longitude), math.cos(longitude))
    declination = math.asin(math.sin(obliquity) * math.sin(longitude))
    hour_angle = sidereal(day + fraction) + lon * RAD - ra
    sine = math.sin(lat * RAD) * math.sin(declination) + math.cos(lat * RAD) * math.cos(declination) * math.cos(hour_angle)
    return math.asin(min(1, max(-1, sine))) / RAD


def refine_extremum(fn, left, right, maximum):
    while right - left > .5:  # Reference precision0.5ms; agreement limit is1s.
        a, b = left + (right - left) / 3, right - (right - left) / 3
        if (fn(a) < fn(b)) == maximum:
            left = a
        else:
            right = b
    return (left + right) / 2


def case(satellite, value):
    lat, lon = value['latitude'], value['longitude']
    origin, up = observer(lat, lon)
    start, end = epoch_ms(value['startUtc']), epoch_ms(value['endUtc'])
    cache = {}

    def sample(at):
        at = round(at, 3)
        if at in cache:
            return cache[at]
        day, fraction = julian(at)
        code, pos, _ = satellite.sgp4(day, fraction)
        if code:
            raise ValueError('Reference propagation failed: ' + str(code))
        angle = sidereal(day + fraction)
        x = math.cos(angle) * pos[0] + math.sin(angle) * pos[1]
        y = -math.sin(angle) * pos[0] + math.cos(angle) * pos[1]
        z = pos[2]
        line = [x - origin[0], y - origin[1], z - origin[2]]
        slant = math.sqrt(sum(v * v for v in line))
        elevation = math.asin(min(1, max(-1, sum(line[i] * up[i] for i in range(3)) / slant))) / RAD
        # Separate WGS84 geodetic latitude iteration.
        p = math.hypot(x, y)
        e2 = (1 / 298.257223563) * (2 - 1 / 298.257223563)
        phi = math.atan2(z, p * (1 - e2))
        for _ in range(12):
            n = 6378.137 / math.sqrt(1 - e2 * math.sin(phi) ** 2)
            phi = math.atan2(z + e2 * n * math.sin(phi), p)
        distance = ground_distance(lat, lon, phi / RAD, math.atan2(y, x) / RAD)
        cache[at] = [elevation, slant, distance]
        return cache[at]

    def crossing(a, b):
        low = sample(a)[0] >= 10
        while b - a > .5:
            middle = (a + b) / 2
            if (sample(middle)[0] >= 10) == low:
                a = middle
            else:
                b = middle
        return (a + b) / 2

    times = list(range(round(start), round(end), 1000)) + [end]
    intervals, opened = [], start if sample(start)[0] >= 10 else None
    for a, b in zip(times, times[1:]):
        before, after = sample(a)[0] >= 10, sample(b)[0] >= 10
        if not before and after:
            opened = crossing(a, b)
        if before and not after:
            intervals.append([opened, crossing(a, b)])
            opened = None
    if opened is not None:
        intervals.append([opened, end])
    result = []
    for a, b in intervals:
        inside = [a] + [t for t in times if a < t < b] + [b]
        peak = max(inside, key=lambda t: sample(t)[0])
        closest = min(inside, key=lambda t: sample(t)[2])
        peak = refine_extremum(lambda t: sample(t)[0], max(a, peak - 1000), min(b, peak + 1000), True)
        closest = refine_extremum(lambda t: sample(t)[2], max(a, closest - 1000), min(b, closest + 1000), False)
        result.append({'startUtc': utc(a), 'endUtc': utc(b), 'peakUtc': utc(peak), 'peakElevationDeg': sample(peak)[0],
                       'slantRangeKm': sample(peak)[1], 'closestUtc': utc(closest), 'closestDistanceKm': sample(closest)[2],
                       'solarAtClosestDeg': sun_elevation(closest, lat, lon), 'clippedStart': a == start, 'clippedEnd': b == end})
    return {'caseId': value['caseId'], 'intervals': result, 'referenceEvaluations': len(cache)}


assert version('sgp4') == '2.27', 'Use the approved verification environment.'
request = json.load(sys.stdin)
results = []
for record in request.get('records', []):
    fields = dict(record['omm'])
    fields['EPOCH'] = fields['EPOCH'].removesuffix('Z')
    satellite = Satrec()
    omm.initialize(satellite, fields, WGS72)
    results.append({'id': record['id'], 'cases': [case(satellite, item) for item in record['cases']]})
json.dump({'sgp4Version': version('sgp4'), 'results': results,
           'solar': [{'id': item['id'], 'elevationDeg': sun_elevation(epoch_ms(item['at']), item['latitude'], item['longitude'])} for item in request.get('solar', [])],
           'distances': [{'id': item['id'], 'km': ground_distance(*item['coordinates'])} for item in request.get('distances', [])],
           'limits': 'Independent implementation agreement, not validated acquisition accuracy; dense1s reference can also miss shorter events.'}, sys.stdout, allow_nan=False)
