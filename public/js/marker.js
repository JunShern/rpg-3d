// marker.js -- where to go next, in the world and on the edge of the screen.
//
// A task line in the corner tells you what; it does not tell you where, and
// a valley is big enough that "the top of the north road" is a ten-minute
// question. Two things answer it: a diamond hanging over the place itself,
// visible from across the field, and an arrow on the screen's edge with the
// distance when the place is off-screen. Both are the grammar every JRPG of
// the last twenty years taught; the only decision is to keep them quiet.

import * as THREE from 'three';

export function makeMarker({ scene, camera }) {
  const geo = new THREE.OctahedronGeometry(0.26, 0);
  const mat = new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.9,
                                            depthTest: false, depthWrite: false, fog: false });
  const gem = new THREE.Mesh(geo, mat);
  gem.renderOrder = 20;
  gem.scale.set(0.8, 1.25, 0.8);
  gem.visible = false;
  gem.raycast = () => {};
  // a soft ring under it, on the ground, so the gem is anchored to a spot
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.72, 40),
    new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.45, side: THREE.DoubleSide,
                                  depthWrite: false, fog: false }));
  ring.rotation.x = -Math.PI / 2;
  ring.renderOrder = 19;
  ring.visible = false;
  ring.raycast = () => {};
  scene.add(gem, ring);

  const arrow = document.createElement('div');
  arrow.id = 'waypoint';
  arrow.style.cssText = 'position:fixed;left:0;top:0;display:none;pointer-events:none;'
    + 'font:600 11px/1.2 system-ui,sans-serif;color:#ffd27a;text-shadow:0 1px 3px #000c;'
    + 'letter-spacing:.06em;text-align:center;transform:translate(-50%,-50%);';
  document.body.appendChild(arrow);

  let target = null;         // THREE.Vector3 or null
  let t = 0;
  const _p = new THREE.Vector3();

  function set(v) {
    target = v ? new THREE.Vector3(v.x, v.y, v.z) : null;
    gem.visible = ring.visible = !!target;
    if (!target) arrow.style.display = 'none';
  }

  function update(dt, playerPos) {
    if (!target) return;
    t += dt;
    gem.position.set(target.x, target.y + 1.7 + Math.sin(t * 2.1) * 0.12, target.z);
    gem.rotation.y = t * 1.4;
    ring.position.set(target.x, target.y + 0.04, target.z);
    const dist = Math.hypot(target.x - playerPos.x, target.z - playerPos.z);
    // the gem is for the middle distance; up close the place speaks for itself
    const near = dist < 4;
    gem.visible = ring.visible = !near;
    // screen-edge arrow when the target is out of frame or far
    _p.copy(gem.position).project(camera);
    const behind = _p.z > 1;
    const onScreen = !behind && Math.abs(_p.x) < 0.9 && Math.abs(_p.y) < 0.85;
    if (onScreen || near) { arrow.style.display = 'none'; return; }
    let x = _p.x, y = _p.y;
    if (behind) { x = -x; y = -1; }
    const ang = Math.atan2(y, x);
    const rx = 0.92, ry = 0.86;                      // an ellipse inside the frame
    const px = Math.cos(ang) * rx, py = Math.sin(ang) * ry;
    const w = window.innerWidth, h = window.innerHeight;
    arrow.style.display = '';
    arrow.style.left = `${(px * 0.5 + 0.5) * w}px`;
    arrow.style.top = `${(-py * 0.5 + 0.5) * h}px`;
    const deg = -ang * 180 / Math.PI;
    arrow.innerHTML = `<div style="transform:rotate(${deg}deg);font-size:18px;line-height:1">➤</div>`
      + `<div>${Math.round(dist)} m</div>`;
  }

  return { set, update, get target() { return target; } };
}
