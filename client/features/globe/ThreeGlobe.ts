import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { circleGeometry, geographicUV, latLonToVector, pointerToNdc, vectorToLatLon } from '../../../shared/globe.js';
import { drawingArea, stableNearSideHit } from '../../../shared/area-proposal.js';
import type { GlobeController, GlobeHover, GlobeSceneCallbacks, GlobeSceneState } from './scene-contract.js';
import { trackIsShown } from './scene-contract.js';

/** The positions and UV grid use Coruscant's single fixed geographic frame. Camera motion never rotates that frame. */
function earthGrid() {
  const width = 160, height = 80, positions: number[] = [], normals: number[] = [], uv: number[] = [], indices: number[] = [];
  for (let y = 0; y <= height; y++) for (let x = 0; x <= width; x++) {
    const latitude = -90 + 180 * y / height, longitude = -180 + 360 * x / width;
    const point = latLonToVector(latitude, longitude), tex = geographicUV(latitude, longitude);
    positions.push(point.x, point.y, point.z); normals.push(point.x, point.y, point.z); uv.push(tex.u, tex.v);
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const a = y * (width + 1) + x, b = a + 1, c = a + width + 1, d = c + 1; indices.push(a, b, c, b, d, c); }
  const grid = new THREE.BufferGeometry(); grid.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); grid.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3)); grid.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); grid.setIndex(indices); return grid;
}
export function createGlobe(host: HTMLElement, callbacks: GlobeSceneCallbacks): GlobeController {
  const canvas = document.createElement('canvas'); canvas.tabIndex = 0; canvas.setAttribute('aria-label', callbacks.canvasLabel ?? 'Demonstration Earth globe'); canvas.setAttribute('aria-describedby', 'globe-keyboard-help'); canvas.setAttribute('role', 'img'); host.append(canvas);
  const context = canvas.getContext('webgl2', { antialias: true, alpha: false });
  if (!context) { canvas.remove(); throw new Error('WebGL2 is unavailable in this browser.'); }
  let renderer: THREE.WebGLRenderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, context, antialias: true, alpha: false }); } catch { canvas.remove(); throw new Error('The browser could not initialize the 3D renderer.'); }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); renderer.setClearColor(0x030405, 1); renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(45, 1, .02, 40);
  const controls = new OrbitControls(camera, canvas); controls.enablePan = false; controls.minDistance = 1.6; controls.maxDistance = 7; controls.minPolarAngle = .02; controls.maxPolarAngle = Math.PI - .02; controls.autoRotateSpeed = .22;
  const settleCamera = (position: THREE.Vector3, target = new THREE.Vector3()) => {
    const wasRotating = controls.autoRotate, wasDamped = controls.enableDamping;
    // Drain OrbitControls' pending damping through its public API, then restore the exact requested pose.
    controls.autoRotate = false; controls.enableDamping = false; controls.update(0);
    camera.position.copy(position); camera.up.set(0, 1, 0); controls.target.copy(target); controls.update(0);
    controls.autoRotate = wasRotating; controls.enableDamping = wasDamped; camera.updateMatrixWorld(true);
  };
  const resetCamera = () => { camera.clearViewOffset(); const n = latLonToVector(18, 35, 3.3); settleCamera(new THREE.Vector3(n.x, n.y, n.z)); };
  resetCamera();
  const earthGeometry = earthGrid(), earthMaterial = new THREE.MeshPhongMaterial({ color: 0x9daeb8, shininess: 1, specular: 0x080b0e });
  const earth = new THREE.Mesh(earthGeometry, earthMaterial); scene.add(earth);
  scene.add(new THREE.AmbientLight(0xb1c5d6, .58)); const light = new THREE.DirectionalLight(0xfff4e5, 1.5); light.position.set(-2, 3, 4); scene.add(light);
  const atmosphereMaterial = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, side: THREE.BackSide, uniforms: {}, vertexShader: 'varying vec3 n; varying vec3 v; void main(){vec4 p=modelViewMatrix*vec4(position,1.);n=normalize(normalMatrix*normal);v=normalize(-p.xyz);gl_Position=projectionMatrix*p;}', fragmentShader: 'varying vec3 n;varying vec3 v;void main(){float rim=pow(1.-abs(dot(normalize(n),normalize(v))),3.);gl_FragColor=vec4(.34,.53,.63,rim*.13);}' });
  const atmosphere = new THREE.Mesh(earthGeometry, atmosphereMaterial); atmosphere.scale.setScalar(1.025); scene.add(atmosphere);
  let disposed = false, width = 1, height = 1, animation = 0, lastFrame = 0;
  let renderDirty = true, appearanceDirty = true, hoverDirty = true, selectedScreenDirty = true;
  const invalidate = () => { renderDirty = true; appearanceDirty = true; hoverDirty = true; selectedScreenDirty = true; };
  const lastCameraWorld = new THREE.Matrix4(), lastCameraProjection = new THREE.Matrix4();
  let cameraCaptured = false;
  let state: GlobeSceneState = { objects: [], selectedId: null, target: null, visibility: 'all', rotating: false, following: false, reducedMotion: false };
  const texture = new THREE.TextureLoader().load('/earth/world.200407.3x5400x2700.jpg', value => {
    if (disposed) { value.dispose(); return; } value.flipY = true; value.colorSpace = THREE.SRGBColorSpace; value.wrapS = THREE.RepeatWrapping; value.wrapT = THREE.ClampToEdgeWrapping; value.rotation = 0; value.offset.set(0, 0); earthMaterial.map = value; earthMaterial.needsUpdate = true; invalidate(); canvas.dataset.texture = 'ready'; callbacks.onTexture('ready');
  }, undefined, () => { if (!disposed) { canvas.dataset.texture = 'unavailable'; callbacks.onTexture('unavailable'); } });
  const pointCanvas = document.createElement('canvas'); pointCanvas.width = pointCanvas.height = 32; const paint = pointCanvas.getContext('2d')!; paint.fillStyle = '#fff'; paint.beginPath(); paint.arc(16, 16, 12, 0, Math.PI * 2); paint.fill();
  const dotTexture = new THREE.CanvasTexture(pointCanvas);
  const group = new THREE.Group(); scene.add(group);
  const objects = new Map<string, { point: THREE.Sprite; paths: Line2[] }>();
  const areaMeshes: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>[] = [], areaRings: Line2[] = [];
  let hovered: string | null = null, lastScreen = '', lastHover = '';
  const setHovered = (id: string | null) => { if (hovered !== id) { hovered = id; renderDirty = true; appearanceDirty = true; } };
  let hoverPointer: { x: number; y: number } | null = null;
  const emitHover = (value: GlobeHover | null) => { const key = value ? value.kind === 'object' ? `object:${value.id}:${value.x.toFixed(1)}:${value.y.toFixed(1)}` : `ground:${value.latitude.toFixed(4)}:${value.longitude.toFixed(4)}:${value.x.toFixed(1)}:${value.y.toFixed(1)}` : ''; if (key !== lastHover) { lastHover = key; callbacks.onHover(value); } };
  const raycaster = new THREE.Raycaster(), earthSurface = new THREE.Sphere(new THREE.Vector3(), 1); let drag: { id: number; x: number; y: number; max: number } | null = null;
  const line = (positions: number[], color: number, linewidth: number, opacity: number) => { const geometry = new LineGeometry(); geometry.setPositions(positions); const material = new LineMaterial({ color, linewidth, transparent: true, opacity, depthTest: true, depthWrite: false, resolution: new THREE.Vector2(width, height) }); const path = new Line2(geometry, material); path.computeLineDistances(); return path; };
  const disposeLine = (path: Line2) => { path.geometry.dispose(); (path.material as LineMaterial).dispose(); };
  const shown = (item: GlobeSceneState['objects'][number]) => trackIsShown(item, state.visibility, state.selectedId);
  const screen = (position: THREE.Vector3) => { const projected = position.clone().project(camera); if (projected.z < -1 || projected.z > 1) return null; raycaster.set(camera.position, position.clone().sub(camera.position).normalize()); const earthHit = raycaster.ray.intersectSphere(earthSurface, new THREE.Vector3()); if (earthHit && camera.position.distanceTo(earthHit) < camera.position.distanceTo(position) - .002) return null; return { x: (projected.x + 1) * width / 2, y: (1 - projected.y) * height / 2 }; };
  const appearance = () => {
    const zoomStrength = Math.min(3, Math.max(1, 3.3 / camera.position.length())), visible = state.objects.filter(shown).length;
    const baseOpacity = Math.min(.45, Math.max(.03, .45 / Math.sqrt(Math.max(1, visible))));
    const allMatched = state.objects.every(item => item.matched), hasUnmatched = state.objects.some(item => !item.matched);
    for (const item of state.objects) {
      const object = objects.get(item.id); if (!object) continue; const selected = item.id === state.selectedId, hover = item.id === hovered;
      object.point.visible = shown(item); for (const path of object.paths) path.visible = shown(item);
      const pixels = selected ? 10 : item.shortlisted ? 8 : hover ? 6 : item.matched ? allMatched ? 2.5 : 5 : hasUnmatched ? 2 : 3;
      const worldPerPixel = 2 * camera.position.distanceTo(object.point.position) * Math.tan(camera.fov * Math.PI / 360) / Math.max(1, height);
      object.point.scale.set(pixels * worldPerPixel, pixels * worldPerPixel, 1); object.point.material.color.setHex(selected || item.shortlisted ? 0xf5913a : item.matched ? 0x78aeba : 0x9da1a7);
      object.point.material.opacity = item.matched || selected || item.shortlisted ? 1 : .4;
      for (const path of object.paths) { const material = path.material as LineMaterial; material.linewidth = selected || item.shortlisted || hover ? 2 : 1.5; material.color.setHex(selected || item.shortlisted ? 0xdbab69 : hover ? 0xf2dbad : 0x78aeba); material.opacity = selected ? .95 : hover ? .9 : item.shortlisted ? .7 : Math.min(.45, baseOpacity * zoomStrength) * (state.selectedId ? .5 : 1); }
    }
    canvas.dataset.pathWidths = JSON.stringify(Object.fromEntries([...objects].filter(([, value]) => value.paths.some(path => path.visible)).map(([id, value]) => [id, (value.paths[0]!.material as LineMaterial).linewidth])));
    canvas.dataset.pointSizes = JSON.stringify(Object.fromEntries(state.objects.filter(shown).map(item => { const value = objects.get(item.id)!; const distance = camera.position.distanceTo(value.point.position); return [item.id, value.point.scale.x / (2 * distance * Math.tan(camera.fov * Math.PI / 360) / Math.max(1, height))]; })));
    canvas.dataset.pointColors = JSON.stringify(Object.fromEntries([...objects].filter(([, value]) => value.point.visible).map(([id, value]) => [id, value.point.material.color.getHexString()])));
    canvas.dataset.shortlistedIds = state.objects.filter(item => item.shortlisted && shown(item)).map(item => item.id).join(',');
    canvas.dataset.cameraPosition = JSON.stringify(camera.position.toArray());
    canvas.dataset.viewOffset = JSON.stringify(camera.view?.enabled ? camera.view : null);
    canvas.dataset.drawableIds = state.objects.filter(shown).map(item => item.id).join(',');
    canvas.dataset.areaMode = state.areaMode ?? 'rotate';
    canvas.dataset.areaPreview = JSON.stringify(state.areaPreview ?? null);
    canvas.dataset.appliedTarget = JSON.stringify(state.target);
    appearanceDirty = false;
  };
  const rebuildAreas = () => {
    for (const mesh of areaMeshes) { scene.remove(mesh); mesh.material.dispose(); } areaMeshes.length = 0;
    for (const path of areaRings) { scene.remove(path); disposeLine(path); } areaRings.length = 0;
    const areas = [...(state.target ? [{ value: state.target, color: state.target.confirmed ? 0xf5913a : 0x7cc7e0, opacity: .16 }] : []), ...(state.areaPreview ? [{ value: state.areaPreview, color: 0xcfe8f0, opacity: .08 }] : [])];
    for (const area of areas) {
      const shape = circleGeometry(area.value.latitude, area.value.longitude, area.value.radiusKm);
      const material = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, uniforms: { capNormal: { value: new THREE.Vector3(shape.normal.x, shape.normal.y, shape.normal.z) }, capCos: { value: shape.cosTheta }, capColor: { value: new THREE.Color(area.color) }, capOpacity: { value: area.opacity } }, vertexShader: 'varying vec3 p;void main(){p=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}', fragmentShader: 'uniform vec3 capNormal;uniform float capCos;uniform vec3 capColor;uniform float capOpacity;varying vec3 p;void main(){if(dot(normalize(p),capNormal)<capCos)discard;gl_FragColor=vec4(capColor,capOpacity);}' });
      const mesh = new THREE.Mesh(earthGeometry, material); mesh.scale.setScalar(areaMeshes.length ? 1.003 : 1.002); scene.add(mesh); areaMeshes.push(mesh);
      if (!shape.global && shape.ring.length > 1) { const path = line(shape.ring.flatMap(value => [value.x, value.y, value.z]), area.color, 1.5, .95); scene.add(path); areaRings.push(path); }
    }
  };
  const rebuild = () => {
    for (const old of objects.values()) { group.remove(old.point, ...old.paths); old.point.material.dispose(); for (const path of old.paths) disposeLine(path); } objects.clear();
    for (const item of state.objects) {
      const point = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTexture, color: 0xffbd66, transparent: true, opacity: 1, depthTest: true, depthWrite: false })); point.position.set(item.position.x, item.position.y, item.position.z); point.userData.itemId = item.id;
      const paths = (item.paths ?? (item.path ? [item.path] : [])).filter(points => points.length > 1).map(points => { const path = line(points.flatMap(value => [value.x, value.y, value.z]), 0x78aeba, 1.5, .2); path.userData.itemId = item.id; return path; }); group.add(point, ...paths); objects.set(item.id, { point, paths });
    }
    rebuildAreas(); appearance();
  };
  const hit = (clientX: number, clientY: number): GlobeHover | null => {
    camera.updateMatrixWorld(true); earth.updateMatrixWorld(true);
    const rect = canvas.getBoundingClientRect(), ndc = pointerToNdc(clientX, clientY, rect); if (!ndc) return null;
    // Tiny visual dots still need a usable pointer target before selection.
    // Test only front-facing plotted points; proximity must never select through Earth.
    const pointHits = [...objects].flatMap(([id, value]) => {
      const location = value.point.visible ? screen(value.point.position) : null;
      if (!location) return [];
      const distance = Math.hypot(clientX - rect.left - location.x, clientY - rect.top - location.y);
      return distance <= 22 ? [{ id, distance }] : [];
    }).sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
    if (pointHits[0]) return { kind: 'object', id: pointHits[0].id, x: clientX - rect.left, y: clientY - rect.top };
    raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera);
    const objectHit = raycaster.intersectObjects([...objects.values()].filter(value => value.point.visible).map(value => value.point))[0], earthHit = raycaster.ray.intersectSphere(earthSurface, new THREE.Vector3());
    if (objectHit && (!earthHit || objectHit.distance < camera.position.distanceTo(earthHit))) return { kind: 'object', id: objectHit.object.userData.itemId as string, x: clientX - rect.left, y: clientY - rect.top };
    if (earthHit) { const coordinates = vectorToLatLon(earthHit); if (coordinates) return { kind: 'ground', latitude: coordinates.latitude, longitude: coordinates.longitude, x: clientX - rect.left, y: clientY - rect.top }; } return null;
  };
  let areaStroke: { id: number; center: THREE.Vector3 } | null = null;
  let pendingTouch: { id: number; center: THREE.Vector3; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null = null;
  const touchPoints = new Map<number, { x: number; y: number }>();
  let pinch: { distance: number; cameraLength: number } | null = null, canceledTouchGesture = false;
  const drawing = () => state.areaMode === 'select';
  const onCanvas = (x: number, y: number) => document.elementFromPoint(x, y) === canvas;
  const earthPoint = (x: number, y: number): THREE.Vector3 | null => {
    if (!onCanvas(x, y)) return null;
    camera.updateMatrixWorld(true); earth.updateMatrixWorld(true);
    const ndc = pointerToNdc(x, y, canvas.getBoundingClientRect()); if (!ndc) return null;
    raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera);
    // Geographic input uses the declared sphere, not the texture mesh's facets:
    // normalizing a triangulated hit changes its ray and introduces km-scale error.
    const value = raycaster.ray.intersectSphere(earthSurface, new THREE.Vector3());
    return value && stableNearSideHit(value, raycaster.ray.direction) ? value.normalize() : null;
  };
  const releasePointer = (id: number) => { if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id); };
  const clearPending = () => { if (pendingTouch) clearTimeout(pendingTouch.timer); pendingTouch = null; };
  const cancelStroke = (message: string, notify = true) => {
    const hadStroke = !!areaStroke || !!pendingTouch; const id = areaStroke?.id ?? pendingTouch?.id;
    areaStroke = null; clearPending(); if (id !== undefined) releasePointer(id);
    if (hadStroke && notify) callbacks.onAreaStroke?.({ phase: 'cancel', message });
  };
  const beginStroke = (id: number, center: THREE.Vector3) => { clearPending(); areaStroke = { id, center }; callbacks.onAreaStroke?.({ phase: 'start' }); };
  const touchDistance = () => { const points = [...touchPoints.values()]; return points.length === 2 ? Math.hypot(points[0]!.x - points[1]!.x, points[0]!.y - points[1]!.y) : 0; };
  const pointerDown = (event: PointerEvent) => {
    if (!drawing()) { if (event.button === 0 && event.isPrimary) { canvas.focus({ preventScroll: true }); drag = { id: event.pointerId, x: event.clientX, y: event.clientY, max: 0 }; } return; }
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.button !== 0 || event.pointerType !== 'touch' && !event.isPrimary) return;
    canvas.focus({ preventScroll: true }); hoverPointer = null; emitHover(null);
    if (event.pointerType === 'touch') {
      touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY }); canvas.setPointerCapture(event.pointerId);
      if (touchPoints.size > 1) {
        if (pendingTouch && !areaStroke && touchPoints.size === 2 && !canceledTouchGesture) {
          // A fresh two-finger idle gesture zooms. Once a stroke has begun, a
          // second touch cancels it and that contact sequence must finish first.
          clearPending(); pinch = { distance: touchDistance(), cameraLength: camera.position.length() };
        } else { cancelStroke('Second touch canceled the stroke. The previous proposal is unchanged.'); pinch = null; canceledTouchGesture = true; }
        return;
      }
      if (canceledTouchGesture) return;
    }
    const value = hit(event.clientX, event.clientY);
    if (value?.kind === 'object') { callbacks.onAreaStroke?.({ phase: 'blocked', message: 'A satellite is under this pointer. Start on an unobstructed Earth point, or edit coordinates.' }); return; }
    const center = earthPoint(event.clientX, event.clientY);
    if (!center) { callbacks.onAreaStroke?.({ phase: 'blocked', message: 'Move onto the visible Earth.' }); return; }
    settleCamera(camera.position.clone(), controls.target.clone()); canvas.setPointerCapture(event.pointerId);
    if (event.pointerType === 'touch') {
      const id = event.pointerId, x = event.clientX, y = event.clientY;
      pendingTouch = { id, center, x, y, timer: setTimeout(() => { if (!disposed && drawing() && touchPoints.size === 1 && pendingTouch?.id === id) beginStroke(id, center); }, 100) };
    } else beginStroke(event.pointerId, center);
  };
  const pointerMove = (event: PointerEvent) => {
    if (drawing()) {
      event.preventDefault(); event.stopImmediatePropagation(); hoverPointer = null; setHovered(null); emitHover(null);
      if (event.pointerType === 'touch' && touchPoints.has(event.pointerId)) touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pinch) { const distance = touchDistance(); if (distance > 0 && pinch.distance > 0) settleCamera(camera.position.clone().setLength(Math.max(1.6, Math.min(7, pinch.cameraLength * pinch.distance / distance))), controls.target.clone()); return; }
      if (canceledTouchGesture) return;
      if (pendingTouch?.id === event.pointerId && Math.hypot(event.clientX - pendingTouch.x, event.clientY - pendingTouch.y) >= 3) beginStroke(pendingTouch.id, pendingTouch.center);
      if (areaStroke?.id === event.pointerId) {
        const edge = earthPoint(event.clientX, event.clientY), measured = edge ? drawingArea(areaStroke.center, edge) : null;
        callbacks.onAreaStroke?.({ phase: 'move', circle: measured?.circle ?? null, message: measured?.message ?? 'Move onto the visible Earth.' });
      }
      return;
    }
    const fine = matchMedia('(hover: hover) and (pointer: fine)').matches && event.pointerType !== 'touch'; hoverPointer = fine ? { x: event.clientX, y: event.clientY } : null; hoverDirty = true;
    if (drag?.id === event.pointerId) { drag.max = Math.max(drag.max, Math.hypot(event.clientX - drag.x, event.clientY - drag.y)); emitHover(null); return; }
    if (!fine) return; const value = hit(event.clientX, event.clientY); setHovered(value?.kind === 'object' ? value.id : null); hoverDirty = false; emitHover(value);
  };
  const pointerUp = (event: PointerEvent) => {
    if (drawing()) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (areaStroke?.id === event.pointerId) {
        const center = areaStroke.center, edge = earthPoint(event.clientX, event.clientY); areaStroke = null;
        const result = edge ? drawingArea(center, edge) : null;
        if (result?.circle) callbacks.onAreaStroke?.({ phase: 'complete', circle: result.circle });
        else callbacks.onAreaStroke?.({ phase: 'cancel', message: result?.message ?? 'Stroke canceled outside the visible Earth. The previous proposal is unchanged.' });
      } else if (pendingTouch?.id === event.pointerId) { clearPending(); callbacks.onAreaStroke?.({ phase: 'cancel', message: 'Drag to set a radius, or enter coordinates.' }); }
      touchPoints.delete(event.pointerId); if (touchPoints.size < 2) pinch = null; if (!touchPoints.size) canceledTouchGesture = false; releasePointer(event.pointerId); return;
    }
    const start = drag; drag = null; if (!start || start.id !== event.pointerId || Math.max(start.max, Math.hypot(event.clientX - start.x, event.clientY - start.y)) >= 6) return;
    const value = hit(event.clientX, event.clientY); if (value?.kind === 'object') callbacks.onSelect(value.id); else if (value?.kind === 'ground') callbacks.onEarthClick?.();
  };
  const leave = () => { setHovered(null); hoverPointer = null; emitHover(null); };
  const cancel = () => { drag = null; cancelStroke('Stroke canceled. The previous proposal is unchanged.'); touchPoints.clear(); pinch = null; canceledTouchGesture = false; leave(); };
  const lostCapture = (event: PointerEvent) => { if (areaStroke?.id === event.pointerId || pendingTouch?.id === event.pointerId) cancel(); };
  const wheel = (event: WheelEvent) => {
    if (!drawing()) return; event.preventDefault(); event.stopImmediatePropagation();
    if (areaStroke || pendingTouch || pinch) return;
    settleCamera(camera.position.clone().setLength(Math.max(1.6, Math.min(7, camera.position.length() * Math.exp(Math.max(-1, Math.min(1, event.deltaY * .001)))))), controls.target.clone());
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (areaStroke || pendingTouch) cancel(); else callbacks.onAreaEscape?.(); return; }
    if (drawing() && (areaStroke || pendingTouch || ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' '].includes(event.key))) { event.preventDefault(); return; }
    if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) { event.preventDefault(); const orbit = new THREE.Spherical().setFromVector3(camera.position); if (event.key === 'ArrowLeft') orbit.theta -= Math.PI / 32; if (event.key === 'ArrowRight') orbit.theta += Math.PI / 32; if (event.key === 'ArrowUp') orbit.phi -= Math.PI / 32; if (event.key === 'ArrowDown') orbit.phi += Math.PI / 32; orbit.phi = Math.max(.02, Math.min(Math.PI - .02, orbit.phi)); camera.position.setFromSpherical(orbit); controls.update(); }
    else if (['+','=','-'].includes(event.key)) { event.preventDefault(); camera.position.setLength(Math.max(1.6, Math.min(7, camera.position.length() * (event.key === '-' ? 1.15 : .85)))); controls.update(); }
    else if (event.key === '0' || event.key === 'Home') { event.preventDefault(); callbacks.onReset(); }
    else if (event.key === ' ') { event.preventDefault(); callbacks.onToggleRotation(); }
  };
  const contextLost = (event: Event) => { event.preventDefault(); if (!disposed) callbacks.onFatal('The browser lost its WebGL2 rendering context. Continue with the same list and request.'); };
  canvas.addEventListener('pointerdown', pointerDown, true); canvas.addEventListener('pointermove', pointerMove, true); canvas.addEventListener('pointerup', pointerUp, true); canvas.addEventListener('pointercancel', cancel); canvas.addEventListener('lostpointercapture', lostCapture); canvas.addEventListener('pointerleave', leave); canvas.addEventListener('wheel', wheel, { capture: true, passive: false }); canvas.addEventListener('keydown', keydown); canvas.addEventListener('webglcontextlost', contextLost); window.addEventListener('blur', cancel);
  const resize = () => { const rect = host.getBoundingClientRect(); const view = camera.view?.enabled ? { x: camera.view.offsetX / camera.view.fullWidth, y: camera.view.offsetY / camera.view.fullHeight } : null; width = Math.max(1, rect.width); height = Math.max(1, rect.height); renderer.setSize(width, height, false); camera.aspect = width / height; if (view) camera.setViewOffset(width, height, view.x * width, view.y * height, width, height); else camera.updateProjectionMatrix(); for (const value of objects.values()) for (const path of value.paths) (path.material as LineMaterial).resolution.set(width, height); for (const ring of areaRings) (ring.material as LineMaterial).resolution.set(width, height); invalidate(); };
  const observer = new ResizeObserver(resize); observer.observe(host); resize();
  const tick = (now: number) => {
    if (disposed || document.visibilityState === 'hidden') { animation = 0; return; }
    const delta = lastFrame ? Math.min(.1, (now - lastFrame) / 1000) : 0; lastFrame = now;
    controls.autoRotate = state.rotating && !state.following && !drawing(); controls.enabled = !drawing(); controls.enableDamping = !state.reducedMotion;
    if (state.following && state.selectedId) { const selected = objects.get(state.selectedId); if (selected?.point.visible) { camera.position.copy(selected.point.position).normalize().multiplyScalar(camera.position.length()); controls.target.set(0, 0, 0); const anchor = state.followAnchor; if (anchor) camera.setViewOffset(width, height, width / 2 - anchor.x, height / 2 - anchor.y, width, height); } }
    if (!areaStroke && !pendingTouch) controls.update(delta);
    camera.updateMatrixWorld(true);
    if (!cameraCaptured || !lastCameraWorld.equals(camera.matrixWorld) || !lastCameraProjection.equals(camera.projectionMatrix)) {
      lastCameraWorld.copy(camera.matrixWorld); lastCameraProjection.copy(camera.projectionMatrix); cameraCaptured = true; invalidate();
    }
    // A stationary pointer still follows the moving Earth/objects. In a paused
    // frame its existing hit remains valid until the model or camera changes.
    if (hoverPointer && !drag && !drawing() && hoverDirty) { const value = hit(hoverPointer.x, hoverPointer.y); setHovered(value?.kind === 'object' ? value.id : null); hoverDirty = false; emitHover(value); }
    if (appearanceDirty) appearance();
    if (renderDirty) { renderer.render(scene, camera); renderDirty = false; }
    if (selectedScreenDirty) {
      const selected = state.selectedId ? objects.get(state.selectedId) : null, location = selected?.point.visible ? screen(selected.point.position) : null;
      const screenKey = location ? `${location.x.toFixed(1)}:${location.y.toFixed(1)}` : '';
      if (screenKey !== lastScreen) { lastScreen = screenKey; callbacks.onSelectedScreen(location); }
      selectedScreenDirty = false;
    }
    animation = requestAnimationFrame(tick);
  };
  const visibility = () => { if (document.visibilityState === 'hidden') { cancelAnimationFrame(animation); animation = 0; cancel(); } else if (!animation && !disposed) { lastFrame = 0; animation = requestAnimationFrame(tick); } };
  document.addEventListener('visibilitychange', visibility); animation = requestAnimationFrame(tick);
  return { update(next) { if (disposed) return; const objectsChanged = state.objects !== next.objects, areasChanged = state.target !== next.target || state.areaPreview !== next.areaPreview; if (state.areaMode !== next.areaMode) { cancelStroke('Stroke canceled. The previous proposal is unchanged.'); touchPoints.clear(); pinch = null; canceledTouchGesture = false; } if (state.rotating && !next.rotating || next.following && !state.following || next.areaMode === 'select' && state.areaMode !== 'select') settleCamera(camera.position.clone(), controls.target.clone()); state = next; invalidate(); controls.autoRotate = state.rotating && !state.following && !drawing(); controls.enabled = !drawing(); if (objectsChanged) rebuild(); else { if (areasChanged) rebuildAreas(); appearance(); } }, reset() { if (!disposed) { state = { ...state, following: false }; resetCamera(); leave(); invalidate(); } }, dispose() {
    if (disposed) return; disposed = true; cancelStroke('', false); cancelAnimationFrame(animation); observer.disconnect(); controls.dispose(); document.removeEventListener('visibilitychange', visibility);
    canvas.removeEventListener('pointerdown', pointerDown, true); canvas.removeEventListener('pointermove', pointerMove, true); canvas.removeEventListener('pointerup', pointerUp, true); canvas.removeEventListener('pointercancel', cancel); canvas.removeEventListener('lostpointercapture', lostCapture); canvas.removeEventListener('pointerleave', leave); canvas.removeEventListener('wheel', wheel, true); canvas.removeEventListener('keydown', keydown); canvas.removeEventListener('webglcontextlost', contextLost); window.removeEventListener('blur', cancel);
    for (const object of objects.values()) { object.point.material.dispose(); for (const path of object.paths) disposeLine(path); } for (const ring of areaRings) disposeLine(ring); for (const circle of areaMeshes) circle.material.dispose(); atmosphereMaterial.dispose(); earthMaterial.dispose(); earthGeometry.dispose(); texture.dispose(); dotTexture.dispose(); renderer.dispose(); renderer.forceContextLoss(); canvas.remove();
  } };
}
