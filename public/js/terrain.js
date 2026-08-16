// terrain.js -- the meadow's height function, ported from the builder.
//
// WHY THIS EXISTS.  The meadow's ground is a 6,120-triangle heightfield, and the
// runtime asks "where is the floor here?" about ten times a frame -- the player,
// both feet for IK, the camera, and every enemy. three.js raycasts a mesh by
// testing every triangle, so that one question cost more than the entire render:
// the plaza ran at 5 ms/frame and the identical scene in the meadow at 24-38 ms,
// and disabling shadows, foliage and half the resolution changed none of it.
//
// The terrain was generated from a closed-form function, so the runtime can just
// evaluate it: O(1), exact, and it cannot disagree with the mesh by more than
// float error.
//
// THE PORT IS VERIFIED, NOT TRUSTED.  The builder emits sample points with the
// heights it actually used; `check()` re-evaluates them here and reports the
// worst disagreement. Two implementations of one formula in two languages is
// exactly the kind of thing that silently drifts.

const TAU = Math.PI * 2;

function ramp(v, a, b) {
  if (v <= a) return 0;
  const k = Math.min(1, (v - a) / (b - a));
  return k * k * (3 - 2 * k);
}

export function makeTerrain(cfg) {
  const { gateY, pathX, hill, x0, x1, y1 } = cfg;
  const [hx, hy, hh, hr] = hill;

  const pathAt = (y) =>
    pathX + 11.0 * Math.sin((y - gateY) * 0.026) + 5.0 * Math.sin((y - gateY) * 0.011);

  // THE STREAM, carved into the height rather than modelled on top of it -- so
  // the bank the player walks down is the same bank the mesh draws. Ported from
  // meadow_build._stream_y / _stream_cut; `check()` below is what catches it
  // when one of the two drifts.
  const { streamY, streamDepth, streamHalf, streamX0, streamX1 } = cfg;
  const streamLine = (x) =>
    streamY + 3.4 * Math.sin(x * 0.055) + 1.5 * Math.sin(x * 0.128 + 1.1);

  function streamCut(x, y) {
    // fades out at both ends: the channel has to stay on the flat middle, or it
    // rides up the flanking hills -- see meadow_build's STREAM_X0/STREAM_X1
    if (x < streamX0 - 4.0 || x > streamX1 + 4.0) return 0;
    const ends = Math.min(ramp(x, streamX0 - 4.0, streamX0),
                          ramp(-x, -streamX1 - 4.0, -streamX1));
    const d = Math.abs(y - streamLine(x));
    if (d > streamHalf + 3.0) return 0;
    const cut = streamDepth * (1 - ramp(d, streamHalf * 0.45, streamHalf + 3.0));
    const ford = 1 - ramp(Math.abs(x - pathAt(y)), 2.2, 5.6);
    return cut * (1 - 0.55 * ford) * ends;
  }

  /** Height in the BUILDER's frame (Blender x, y). */
  function heightXY(x, y) {
    if (y < gateY) return -0.05;

    const t = Math.min(1, (y - gateY) / 9.0);
    let h = 1.55 * Math.sin(x * 0.055) * Math.cos(y * 0.043)
          + 0.95 * Math.sin(x * 0.101 + 1.7) * Math.sin(y * 0.088 + 0.4)
          + 0.40 * Math.sin(x * 0.223 + 0.9) * Math.cos(y * 0.197 + 2.2);

    const d = Math.hypot(x - hx, y - hy) / hr;
    if (d < 1) h += hh * Math.pow(Math.cos(d * Math.PI) * 0.5 + 0.5, 1.5);

    h += ramp(y, y1 - 26.0, y1) * 15.0;
    h += ramp(-x, -x0 - 22.0, -x0) * 12.0;
    h += ramp(x, x1 - 22.0, x1) * 12.0;

    const pw = 1.0 - ramp(Math.abs(x - pathAt(y)), 2.6, 6.4);
    // two-stage climb: brisk out of town, gentler past halfway, and it never
    // levels off -- see meadow_build._path_height
    const road = ramp(y, gateY, 62.0) * 3.4 + ramp(y, 58.0, 104.0) * 2.9;
    h = h * (1 - pw) + road * pw;

    // AFTER the path blend, not before -- see meadow_build.height
    h -= streamCut(x, y);

    const seam = 0.05 * (1 - Math.min(1, (y - gateY) / 3.0));
    return h * t - seam;
  }

  // SAMPLE THE MESH, NOT THE FUNCTION.
  //
  // The mesh is flat quads on a grid; the function is smooth. Between grid
  // points a quad chords BELOW the true surface -- up to 21 cm on the hill --
  // so evaluating the function directly leaves the player hovering over the
  // ground they can see. Interpolating the same two triangles the renderer
  // draws makes the collision surface and the visible surface the same thing.
  const { gridX0, gridY0, step } = cfg;

  function heightMesh(x, y) {
    if (step === undefined) return heightXY(x, y);
    const fx = (x - gridX0) / step;
    const fy = (y - gridY0) / step;
    const i = Math.floor(fx), j = Math.floor(fy);
    const u = fx - i, v = fy - j;
    const gx = gridX0 + i * step, gy = gridY0 + j * step;
    const h00 = heightXY(gx, gy);
    const h11 = heightXY(gx + step, gy + step);
    // quads are wound (i,j)->(i+1,j)->(i+1,j+1)->(i,j+1) and split 0-1-2 / 0-2-3
    if (v <= u) {
      const h10 = heightXY(gx + step, gy);
      return h00 + (h10 - h00) * u + (h11 - h10) * v;
    }
    const h01 = heightXY(gx, gy + step);
    return h00 + (h11 - h01) * u + (h01 - h00) * v;
  }

  /** Height in the RUNTIME's frame. glTF maps Blender y to three -z. */
  const heightAt = (x, z) => heightMesh(x, -z);

  /** True where this function -- not the town's raycast -- owns the ground. */
  const owns = (x, z) => (-z) >= gateY && x > x0 && x < x1 && (-z) < y1;

  function check(probes) {
    let worst = 0, at = null;
    for (const [px, py, expected] of probes || []) {
      const got = heightXY(px, py);
      const d = Math.abs(got - expected);
      if (d > worst) { worst = d; at = [px, py, expected, +got.toFixed(5)]; }
    }
    return { worst: +worst.toFixed(6), at, n: (probes || []).length };
  }

  return { heightAt, heightXY, heightMesh, owns, pathAt, check, cfg };
}
