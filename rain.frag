#version 440

layout(location = 0) in vec2 qt_TexCoord0;
layout(location = 0) out vec4 fragColor;

layout(std140, binding = 0) uniform buf {
    mat4 qt_Matrix;
    float qt_Opacity;
    float time;
    vec2 uRes;
    float uIntensity;
    float uSpeed;
    float uFlash;
    float uStrike;
    float uStrikeSeed;
    vec2 uStrikePos;
    float uEffect;
    float uAudio;
    float uVariant;
    float uCorner;
    float uStraightness;
};

float hash(vec2 p)
{
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

vec2 hash2(vec2 p)
{
    return vec2(hash(p), hash(p + vec2(17.7, 3.7)));
}

// Smooth value noise (hash-based, bilinear interpolation) — used for the snow
// drift/tumble so flakes sway gently instead of marching in straight lines.
float vnoise(vec2 q)
{
    vec2 i = floor(q);
    vec2 f = fract(q);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

// One snow layer in pixel space. Every cell of `cell` pixels carries a single
// soft round flake that falls at its own speed and sways sideways with a
// gentle breeze; a wobble in its size keeps near flakes from feeling static.
// `drift` is a horizontal offset in pixels added on top so the whole layer
// streams with the wind.
float snowLayer(vec2 p, vec2 cell, float size, float flow, vec2 seed, float drift)
{
    vec2 gp = p + vec2(drift, 0.0);
    vec2 sc = gp / cell;
    vec2 sg = floor(sc);
    vec2 sf = fract(sc);
    vec2 rs = hash2(sg + seed);
    float fy = fract(rs.y * 7.31 + flow * (0.22 + 0.78 * rs.x));
    float fx = 0.5 + (rs.x - 0.5) * 0.55
             + 0.22 * sin(flow * (0.5 + 0.7 * rs.y) + rs.x * 7.2);
    float sway = 0.75 + 0.5 * vnoise(vec2(sg.x * 0.7 + seed.x, flow * 0.35 + seed.y));
    vec2 fl = vec2(fx, fy);
    vec2 dpx = (sf - fl) * cell;
    // Exact pixel cull: past the 1.15 falloff the flake contributes nothing.
    float denom = max(0.5 * size * sway, 1.0);
    float lim = 1.15 * denom;
    if (dot(dpx, dpx) > lim * lim) return 0.0;
    float dist = length(dpx) / denom;
    float a = 1.0 - smoothstep(0.4, 1.15, dist);
    a *= 0.55 + 0.45 * vnoise(vec2(rs.x * 3.3, flow * 1.4));
    return max(a, 0.0);
}

// One puddle-ripple layer. Every cell hosts a drop that lands at a random
// offset and throws up a ring; the ring expands across the cell's lifetime and
// fades out before it reaches the boundary, and an envelope kills it at the
// cell edges too, so the tiling never shows hard seams.
float rippleLayer(vec2 p, vec2 cell, float flow, vec2 seed, float amp, float w)
{
    vec2 sc = p / cell;
    vec2 sg = floor(sc);
    vec2 sf = fract(sc);
    vec2 rs = hash2(sg + seed);
    float phase = fract(rs.x * 3.7 + flow * (0.35 + 0.55 * rs.y));
    float maxR = 0.46 * min(cell.x, cell.y) * (0.65 + 0.7 * rs.y);
    float radius = phase * maxR;
    float fade = (1.0 - smoothstep(0.10, 0.92, phase))
               * (0.4 + 0.6 * vnoise(vec2(sg.x * 0.6, flow * 0.5 + rs.y * 2.0)));
    vec2 off = (sf - 0.5) * cell;
    float r = length(off);
    float ring = 1.0 - smoothstep(0.0, w, abs(r - radius));
    float env = min(1.0 - smoothstep(0.16, 0.46, abs(sf.x - 0.5)),
                    1.0 - smoothstep(0.16, 0.46, abs(sf.y - 0.5)));
    return max(ring * fade * env, 0.0) * amp;
}

// One floating-dust layer. Each cell carries a mote that barely moves — a
// long, slow vertical wander and a lazy figure-eight sway — so the motes hang
// in the air and drift through the light rather than actively falling.
float dustLayer(vec2 p, vec2 cell, float size, float flow, vec2 seed, float drift)
{
    vec2 gp = p + vec2(drift, 0.0);
    vec2 sc = gp / cell;
    vec2 sg = floor(sc);
    vec2 sf = fract(sc);
    vec2 rs = hash2(sg + seed);
    float fy = fract(rs.y * 5.11 + flow * (0.03 + 0.12 * rs.x));
    float fx = 0.5 + (rs.x - 0.5) * 0.7
             + 0.35 * sin(flow * (0.15 + 0.25 * rs.y) + rs.x * 9.1)
             + 0.20 * sin(flow * (0.07 + 0.17 * rs.y) + rs.x * 4.2);
    vec2 fl = vec2(fx, fy);
    vec2 dpx = (sf - fl) * cell;
    // Exact pixel cull: beyond the falloff radius the mote contributes nothing,
    // so skip the sqrt/smoothstep (and the second noise) entirely.
    float denom = max(0.35 * size, 1.0);
    float lim = 1.20 * denom;
    if (dot(dpx, dpx) > lim * lim) return 0.0;
    float dist = length(dpx) / denom;
    float a = 1.0 - smoothstep(0.30, 1.20, dist);
    a *= 0.6 + 0.4 * vnoise(vec2(rs.x * 2.3, flow * 0.3));
    return max(a, 0.0);
}

// One firefly layer. Each cell carries a single firefly: a bright tiny core
// wrapped in a soft glow, wandering slowly with two offset sweeping sways and
// pulsing its light with its own phase and rate so the scene quietly blinks
// at dusk.
float fireflyLayer(vec2 p, vec2 cell, float size, float flow, vec2 seed, float drift)
{
    vec2 gp = p + vec2(drift, 0.0);
    vec2 sc = gp / cell;
    vec2 sg = floor(sc);
    vec2 sf = fract(sc);
    vec2 rs = hash2(sg + seed);
    float fy = fract(rs.y * 3.7 + flow * (0.05 + 0.15 * rs.x));
    float fx = 0.5 + (rs.x - 0.5) * 0.6
             + 0.30 * sin(flow * (0.10 + 0.18 * rs.y) + rs.x * 5.3)
             + 0.18 * sin(flow * (0.12 + 0.24 * rs.x) + rs.y * 7.1 + 2.0);
    vec2 fl = vec2(fx, fy);
    vec2 dpx = (sf - fl) * cell;
    float lim = size * 2.5;
    if (dot(dpx, dpx) > lim * lim) return 0.0;
    float d = length(dpx);
    float halo = 1.0 - smoothstep(size * 0.5, size * 2.5, d);
    float core = 1.0 - smoothstep(0.0, size * 0.45, d);
    float pulse = 0.55 + 0.45 * sin(flow * (0.8 + 0.9 * rs.y) + rs.x * 6.28);
    return max(core * 0.9 + halo * 0.35, 0.0) * pulse;
}

// One ember layer: a sparse drifting fire spark that rises slowly, sways on
// its way up, and flickers with its own two-tone brightness. `drift` is a
// horizontal offset in pixels that streams the whole field sideways like a
// breeze, `size` scales the glow, and `seed` scatters the cells.
float emberLayer(vec2 p, vec2 cell, float size, float flow, vec2 seed, float drift)
{
    vec2 gp = p + vec2(drift, 0.0);
    vec2 sc = gp / cell;
    vec2 sg = floor(sc);
    vec2 sf = fract(sc);
    vec2 rs = hash2(sg + seed);
    // Rise slowly, each ember at its own pace, wrapping back in at the top.
    float fy = fract(rs.y * 6.7 - flow * (0.12 + 0.28 * rs.x));
    float fx = 0.5 + (rs.x - 0.5) * 0.5
             + 0.25 * sin(flow * (0.35 + 0.5 * rs.y) + rs.x * 5.1)
             + 0.12 * sin(flow * (0.9 + 0.4 * rs.x) + rs.y * 4.3);
    vec2 fl = vec2(fx, fy);
    vec2 dpx = (sf - fl) * cell;
    float lim = size * 2.6;
    if (dot(dpx, dpx) > lim * lim) return 0.0;
    float d = length(dpx);
    float halo = 1.0 - smoothstep(size * 0.5, size * 2.6, d);
    float core = 1.0 - smoothstep(0.0, size * 0.5, d);
    // Two-tone flicker: the ember pulses and occasionally flares.
    float flicker = 0.5 + 0.5 * sin(flow * (1.2 + 1.6 * rs.y) + rs.x * 6.28);
    flicker *= 0.7 + 0.3 * sin(flow * (3.1 + 2.4 * rs.x) + rs.y * 11.3);
    return max(core * 0.98 + halo * 0.22, 0.0) * flicker;
}

// One bubble field: the screen width is tiled into wide cells, each carrying
// `count` bubbles. Vertically each bubble rises the *entire* screen, entering
// at the bottom edge and leaving at the top, so there are no internal row
// seams at all. Horizontally each bubble wanders freely and is sampled across
// its own and both neighbouring cells, so the path stays continuous across
// cell edges; the only wrap is horizontal, and a per-bubble fade masks it.
// `size` sets the bubble radius, `rate` the rise speed, `drift` staggers the
// cells sideways, and `seed` scatters them. Returns (rim+highlight
// brightness, interior fill).
vec2 bubbleLayer(vec2 p, float cellW, float count, float size, float rate, float flow, vec2 seed, float drift)
{
    float gp = p.x + drift;
    float c0 = floor(gp / cellW);
    vec3 best = vec3(1e20, 0.5, 0.0);
    vec2 dvec = vec2(0.0);
    // A bubble's falloff reaches at most (max radius + 1) px, with max radius
    // size * 1.2 (wobble tops out at 1.2). Cull a neighbour cell exactly when
    // the pixel lies further than that from the cell's horizontal span.
    float reach = size * 1.2 + 1.0;
    for (int m = -1; m <= 1; m++) {
        float c = c0 + float(m);
        float cellMin = c * cellW;
        float cellMax = cellMin + cellW;
        float edge = 0.0;
        if (p.x < cellMin) edge = cellMin - p.x;
        else if (p.x > cellMax) edge = p.x - cellMax;
        if (edge >= reach) continue;
        for (int k = 0; k < 10; k++) {
            if (float(k) >= count) break;
            vec2 rs = hash2(vec2(c * 91.33 + seed.x + float(k) * 17.71,
                                seed.y + 4.7 + float(k) * 3.1));
            // Horizontal wander; wraps across cell edges.
            float w = 0.5 + (rs.x - 0.5) * 0.7
                    + 0.18 * sin(flow * (0.30 + 0.25 * rs.y) + rs.x * 4.7);
            float bx = fract(w);
            // Rise the whole screen height: enter bottom, exit top.
            float v = rate * (0.55 + 0.45 * rs.y);
            float by = uRes.y * (1.0 - fract(rs.x * 7.31 + flow * v));
            float sx = (c + bx) * cellW;
            float dx = p.x - sx;
            float dy = p.y - by;
            float d2 = dx * dx + dy * dy;
            if (d2 < best.x) {
                best = vec3(d2, rs.y, bx);
                dvec = vec2(dx, dy);
            }
        }
    }
    float d = sqrt(best.x);
    // Fade only around the bubble's own horizontal wrap, never in stripes.
    float bx = best.z;
    float wrap = smoothstep(0.02, 0.07, bx) * (1.0 - smoothstep(0.93, 0.98, bx));
    float wob = 0.8 + 0.4 * vnoise(vec2(best.y * 3.1, flow * 0.6));
    float r = size * wob;
    float m = 1.0 - smoothstep(r, r + 1.0, d);
    float rim = smoothstep(r * 0.80, r * 0.97, d) * m;
    vec2 hl = dvec - vec2(-r * 0.30, -r * 0.35);
    float spot = 1.0 - smoothstep(0.0, r * 0.30, length(hl));
    float fill = m * (1.0 - rim * 0.8) * 0.5;
    return vec2((rim * 0.55 + spot * 0.45) * wrap, fill * wrap);
}

// One falling-leaf layer: an autumn leaf of `size` px that tumbles edge-on as
// it crosses the whole screen. Particle identity comes from the lane hash, so
// every leaf keeps its own palette for its whole descent.
vec3 leafLayer(vec2 p, vec2 cell, float size, float flow, vec2 seed, float drift)
{
    vec2 gp = p + vec2(drift, 0.0);
    vec2 sc = gp / cell;
    vec2 sg = floor(sc);
    vec2 sf = fract(sc);
    vec2 rs = hash2(sg + seed);
    float fy = fract(rs.y * 5.61 + flow * (0.25 + 0.55 * rs.x));
    float fx = 0.5 + (rs.x - 0.5) * 0.55
             + 0.30 * sin(flow * (0.6 + 0.8 * rs.y) + rs.x * 6.1)
             + 0.18 * sin(flow * (1.0 + 0.6 * rs.x) + rs.y * 4.3);
    vec2 fl = vec2(fx, fy);
    vec2 dpx = (sf - fl) * cell;

    // Rock side to side and slowly tumble so leaves flip over as they fall.
    float ang = sin(flow * (0.9 + 1.4 * rs.y) + rs.x * 5.3) * 1.1
              + flow * 0.25 * sign(rs.x - 0.5);
    float ca = cos(ang), sa = sin(ang);
    vec2 rr = vec2(dpx.x * ca - dpx.y * sa, dpx.x * sa + dpx.y * ca);

    // Silhouette: an elongated ellipse that thins out when seen edge-on.
    float maj = max(size, 1.0);
    float minr = max(size * 0.38 * (0.35 + 0.65 * abs(ca)), 1.0);
    float ex = rr.x / maj;
    float ey = rr.y / minr;
    float d = sqrt(ex * ex + ey * ey);
    float a = 1.0 - smoothstep(0.75, 1.20, d);
    a *= 0.55 + 0.45 * vnoise(vec2(rs.x * 2.9, flow * 0.7 + rs.y * 2.0));
    if (a <= 0.0) return vec3(0.0);

    // Autumn palette: rust, gold, deep red — mixed per leaf and slightly
    // darkened when the leaf is seen edge-on.
    float pal = hash(sg * 0.5 + seed + vec2(3.9, 7.1));
    vec3 col = mix(vec3(0.82, 0.42, 0.10),
                   vec3(0.90, 0.64, 0.18), smoothstep(0.15, 0.55, pal));
    col = mix(col, vec3(0.60, 0.20, 0.04), smoothstep(0.65, 0.90, pal));
    col *= 0.55 + 0.45 * abs(ca);
    return col * max(a, 0.0);
}

// One confetti layer: small bright paper rectangles that flutter down a lane,
// spinning as they fall and thinning out edge-on. Same full-screen fall as the
// leaf layer; each piece carries its own festive colour and tumble.
vec3 confettiLayer(vec2 p, vec2 cell, float size, float flow, vec2 seed, float drift)
{
    vec2 gp = p + vec2(drift, 0.0);
    vec2 sc = gp / cell;
    vec2 sg = floor(sc);
    vec2 sf = fract(sc);
    vec2 rs = hash2(sg + seed);
    float fy = fract(rs.y * 4.7 + flow * (0.35 + 0.5 * rs.x));
    float fx = 0.5 + (rs.x - 0.5) * 0.55
             + 0.32 * sin(flow * (0.7 + 0.9 * rs.y) + rs.x * 5.9)
             + 0.14 * sin(flow * (1.4 + 0.5 * rs.x) + rs.y * 3.7);
    vec2 fl = vec2(fx, fy);
    vec2 dpx = (sf - fl) * cell;

    // Fast tumble about the piece's long axis, plus a slow flutter that thins
    // the piece when it is seen edge-on.
    float spin = flow * (3.0 + 3.2 * rs.y) + rs.x * 6.1;
    float ca = cos(spin), sa = sin(spin);
    vec2 rr = vec2(dpx.x * ca - dpx.y * sa, dpx.x * sa + dpx.y * ca);
    float flap = sin(spin * 0.35 + rs.x * 4.1);
    float W = size;
    float H = max(size * 0.45, 0.9) * (0.30 + 0.70 * abs(flap));
    float ex = abs(rr.x) / W;
    float ey = abs(rr.y) / H;
    float d = max(ex, ey);
    float a = 1.0 - smoothstep(0.75, 1.10, d);
    a *= 0.75 + 0.25 * vnoise(vec2(rs.x * 3.3, flow * 0.8 + rs.y * 2.3));
    if (a <= 0.0) return vec3(0.0);

    // Bright confetti palette: red, blue, gold, green, pink.
    float pal = hash(sg * 0.4 + seed + vec2(5.1, 3.9));
    vec3 col = mix(vec3(0.95, 0.22, 0.30), vec3(0.16, 0.70, 0.95), smoothstep(0.0, 0.25, pal));
    col = mix(col, vec3(1.00, 0.80, 0.10), smoothstep(0.30, 0.50, pal));
    col = mix(col, vec3(0.20, 0.85, 0.40), smoothstep(0.55, 0.70, pal));
    col = mix(col, vec3(0.95, 0.50, 0.85), smoothstep(0.75, 0.90, pal));
    col *= 0.65 + 0.35 * abs(flap);
    return col * max(a, 0.0);
}

// One rain layer in pixel space. Every cell of `cell` pixels carries a single
// streak `th` px wide and up to `cell.y` px long, falling at its own speed,
// bright at the head and tapering along the tail, wrapping back into the top
// of the cell when it exits the bottom.
float rainLayer(vec2 p, vec2 cell, float th, float fast, float flow, vec2 seed)
{
    vec2 c = p / cell;
    vec2 g = floor(c);
    vec2 f = fract(c);

    vec2 rs = hash2(g * 1.7 + seed);
    float speed = 0.5 + 1.6 * rs.x;
    float len = cell.y * (0.2 + 0.45 * rs.y);
    float xoff = (rs.x - 0.5) * 0.42;
    float phase = hash(g * 1.7 + seed + 2.3);

    float px = f.x - 0.5 - xoff;
    float y = fract(f.y - flow * fast * speed + phase);
    // Quadratic fit of pow(hv, 1.9) (max err ~0.005 on [0,1]): one mul, no pow.
    float hv = 1.0 - clamp(y * cell.y / max(len, 1.0), 0.0, 1.0);
    float head = hv * (0.072 + 0.928 * hv);

    float distx = abs(px * cell.x);
    float col = 1.0 - smoothstep(0.0, th, distx);
    return col * head;
}

// --------------------------------------------------------------------------
// Lightning bolt. A deterministic 8-segment jagged path seeded per strike,
// drawn as the distance to its polyline (plus one side branch), so it reads
// as an actual bolt rather than a screen flash. Positions are in pixels.
// --------------------------------------------------------------------------

float segDistSq(vec2 p, vec2 a, vec2 b)
{
    vec2 ab = b - a;
    float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1.0), 0.0, 1.0);
    vec2 q = a + t * ab;
    return dot(p - q, p - q);
}

vec2 boltPoint(int i, vec2 start, float lenPx, float ampPx, float seed)
{
    float t = float(i) / 8.0;
    float hx = hash(vec2(seed + t * 37.0, seed * 1.31 + 5.7));
    float side = mod(float(i), 2.0) * 2.0 - 1.0;
    float taper = 1.0 - 0.25 * t;
    return vec2(start.x + side * (hx - 0.5) * ampPx * 2.0 * taper,
                start.y + t * lenPx);
}

float lightningBolt(vec2 p, vec2 start, float lenPx, float ampPx, float seed)
{
    // The bolt's polyline is fixed for the whole flash, but until now every
    // fragment re-derived each point twice (once per shared endpoint). Resolve
    // all 9 joints once into a local array, then reuse them for the distance
    // scan and the side branch.
    vec2 pts[9];
    for (int i = 0; i <= 8; i++) {
        pts[i] = boltPoint(i, start, lenPx, ampPx, seed);
    }
    vec2 br = pts[3];
    float bdx = (hash(vec2(seed + 91.0, 3.3)) - 0.5) * ampPx * 1.6;
    float bdy = lenPx * 0.16;
    vec2 branchEnd = br + vec2(bdx, bdy);

    // Exact screen-space cull using the bolt's own bounding box expanded by the
    // glow's visibility distance: beyond ~92 px the exp glow is < 1/255, so the
    // pixel can't see the bolt (or its glow) at all. These reach the outline
    // box only while a strike is live, and then skip the whole scan.
    vec2 bmin = pts[0];
    vec2 bmax = pts[0];
    for (int i = 1; i <= 8; i++) {
        bmin = min(bmin, pts[i]);
        bmax = max(bmax, pts[i]);
    }
    bmin = min(bmin, branchEnd);
    bmax = max(bmax, branchEnd);
    float pad = 92.0;
    if (p.x < bmin.x - pad || p.x > bmax.x + pad ||
        p.y < bmin.y - pad || p.y > bmax.y + pad) {
        return 1e12;
    }

    float d = 1e12;
    for (int i = 1; i <= 8; i++) {
        d = min(d, segDistSq(p, pts[i - 1], pts[i]));
    }
    // One short side branch off the third joint.
    d = min(d, segDistSq(p, br, branchEnd));
    return d;
}

void main()
{
    // Continuous time, no modulo: wrapping would teleport every streak at the
    // wrap instant. Precision far exceeds realistic session lengths.
    float flow = time * uSpeed;
    vec2 p = qt_TexCoord0 * uRes;

    // Effect switch. Each branch owns its output.
    // Rain: three depth layers of slanted streaks over a wet window dim, with
    // optional lightning.
    if (uEffect < 0.5) {
        // Slight screen-space slant so the rain reads as falling at an angle.
        p.x += p.y * 0.08;

        // Density (uIntensity 1..3 grows 0.65 -> 1.6 here) tightens the column
        // spacing so higher intensity packs in visibly more drops; the alpha
        // also climbs with it for a wetter read.
        float i = 0.65 + (uIntensity - 1.0) * 0.475;
        float a1 = rainLayer(p, vec2(20.0 / i, 96.0), 1.5, 1.00, flow, vec2(3.1, 1.7)) * 0.34;
        float a2 = rainLayer(p, vec2(34.0 / i, 160.0), 1.2, 0.62, flow, vec2(9.4, 2.9)) * 0.19;
        float a3 = rainLayer(p, vec2(56.0 / i, 240.0), 0.9, 0.36, flow, vec2(5.2, 7.1)) * 0.13;

        float total = clamp(a1 + a2 + a3, 0.0, 1.0);

        // Pale steel-blue streaks; the wet-down look darkens and cools the
        // wallpaper as the rain builds up.
        vec3 wet = vec3(0.55, 0.65, 0.85);
        vec3 col = wet * (0.4 + 1.1 * total);

        // Lightning: a distant-strike cloud glow plus the drawn bolt.
        float flash = uFlash;
        col += vec3(0.28, 0.31, 0.38) * flash * 0.6;

        float boltAlpha = 0.0;
        if (uStrike > 0.001) {
            vec2 start = vec2(uStrikePos.x * uRes.x, 0.03 * uRes.y);
            float lenPx = uStrikePos.y * uRes.y * 0.75;
            float ampPx = 0.03 * uRes.x;
            float d = lightningBolt(p, start, lenPx, ampPx, uStrikeSeed);
            float dist = sqrt(max(d, 0.0));
            float core = 1.0 - smoothstep(0.0, 1.4, dist);
            float glow = exp(-dist * 0.06) * 0.5;
            boltAlpha = (core + glow) * uStrike;
            col += vec3(0.72, 0.82, 1.0) * boltAlpha;
        }

        // A wet-window dim plus the streaks' own alpha keeps drops visible on
        // both bright and dark wallpapers. Heavier rain darkens the scene more.
        float wetness = 0.10 * total + 0.05 * (uIntensity - 1.0);
        float dim = wetness + 0.10 * flash;
        float alpha = clamp(dim + total * (0.36 + 0.10 * uIntensity), 0.0, 1.0);
        alpha += clamp(boltAlpha, 0.0, 1.0) * 0.9;
        alpha *= qt_Opacity;

        fragColor = vec4(col, alpha);
        return;
    }

    // Snow: three depth layers of drifting flakes over a cool brightening.
    if (uEffect < 1.5) {
        float i = 1.0 + (uIntensity - 1.0) * 0.5;
        float a1 = snowLayer(p, vec2(26.0, 40.0) / i, 2.0, flow, vec2(4.1, 9.3), flow * 6.0) * 0.5;
        float a2 = snowLayer(p, vec2(48.0, 78.0) / i, 3.4, flow, vec2(8.7, 2.4), flow * 9.0) * 0.8;
        float a3 = snowLayer(p, vec2(88.0, 150.0) / i, 6.0, flow, vec2(2.2, 6.6), flow * 13.0) * 1.0;
        float total = clamp(a1 + a2 + a3, 0.0, 1.0);

        vec3 col = vec3(0.80, 0.86, 0.98) * (0.30 + 1.05 * total);
        float alpha = clamp(total * 0.95 + 0.04 * (uIntensity - 1.0), 0.0, 1.0);
        fragColor = vec4(col, alpha * qt_Opacity);
        return;
    }

    // Puddle ripples: drops hitting a notional water surface throw up
    // expanding rings, with a light sprinkle overhead.
    if (uEffect > 1.5 && uEffect < 2.5) {
        float i = 1.0 + (uIntensity - 1.0) * 0.5;
        float r1 = rippleLayer(p, vec2(36.0, 36.0) / i, flow, vec2(5.1, 8.3), 0.45, 1.2);
        float r2 = rippleLayer(p, vec2(78.0, 78.0) / i, flow, vec2(11.7, 3.1), 0.75, 1.8);
        float r3 = rippleLayer(p, vec2(150.0, 150.0) / i, flow, vec2(2.6, 9.4), 1.00, 2.4);
        float ripples = clamp(r1 + r2 + r3, 0.0, 1.2);

        float sp = rainLayer(p, vec2(30.0, 120.0), 1.1, 0.9, flow, vec2(9.4, 2.9)) * 0.35;

        vec3 col = vec3(0.45, 0.53, 0.66) * (0.35 + 0.55 * sp);
        col += vec3(0.82, 0.90, 1.00) * ripples * 0.9;

        float alpha = clamp(0.30 * sp + ripples * 0.95 + 0.06, 0.0, 1.0);
        fragColor = vec4(col, alpha * qt_Opacity);
        return;
    }

    // Floating dust motes: sparse, barely-moving specks drifting through a
    // faint diagonal shaft of light. Meant to be subtle — the wallpaper stays
    // visible, the motes just settle the scene like motes in a sunbeam.
    if (uEffect > 2.5 && uEffect < 3.5) {
        float i = 1.0 + (uIntensity - 1.0) * 0.45;
        float m1 = dustLayer(p, vec2(46.0, 54.0) / i, 1.5, flow, vec2(6.2, 3.8), flow * 1.2) * 0.5;
        float m2 = dustLayer(p, vec2(92.0, 108.0) / i, 2.2, flow, vec2(3.1, 8.9), flow * 1.8) * 0.8;
        float m3 = dustLayer(p, vec2(160.0, 180.0) / i, 3.2, flow, vec2(9.7, 2.6), flow * 2.4) * 1.0;
        float motes = clamp(m1 + m2 + m3, 0.0, 0.95);

        vec2 o = vec2(-0.18 * uRes.x, -0.08 * uRes.y);
        vec2 dd = vec2(0.75, 0.55);
        float tt = clamp(dot(p - o, dd) / dot(dd, dd), 0.0, 1.6);
        vec2 proj = o + dd * tt;
        float beamD = length(p - proj);
        float halfW = 0.12 * uRes.x;
        float beam = exp(-beamD * beamD / (halfW * halfW * 2.0)) * 0.55;
        beam *= 0.22;

        vec3 col = vec3(0.98, 0.94, 0.85) * (0.10 + 0.55 * motes + beam * 0.7);
        float alpha = clamp(motes * 0.85 + beam * 0.5, 0.0, 1.0);
        fragColor = vec4(col, alpha * qt_Opacity);
        return;
    }

    // Fireflies: sparse warm-green points of light wandering slowly through a
    // faint dusk, each blinking with its own phase and rate.
    if (uEffect > 3.5 && uEffect < 4.5) {
        float i = 1.0 + (uIntensity - 1.0) * 0.5;
        float f1 = fireflyLayer(p, vec2(80.0, 90.0) / i, 2.0, flow, vec2(7.4, 2.1), flow * 1.0) * 0.7;
        float f2 = fireflyLayer(p, vec2(160.0, 175.0) / i, 2.8, flow, vec2(3.9, 6.4), flow * 1.6) * 0.9;
        float f3 = fireflyLayer(p, vec2(280.0, 300.0) / i, 3.6, flow, vec2(8.8, 4.9), flow * 2.2) * 1.0;
        float flies = clamp(f1 + f2 + f3, 0.0, 1.1);

        vec3 glow = vec3(0.85, 0.95, 0.45);
        vec3 col = vec3(0.24, 0.30, 0.34) * 0.16;
        col += glow * flies * 0.85;
        float alpha = clamp(flies * 0.9 + 0.05, 0.0, 1.0);
        fragColor = vec4(col, alpha * qt_Opacity);
        return;
    }

    // Falling leaves: three depth layers of leaves tumbling down over a warm,
    // slightly golden evening light. Each leaf is a rotated ellipse in a warm
    // palette that rocks side to side as it falls. The variant switch only
    // swaps the palette (autumn rust/gold vs cherry white/pink); the motion,
    // depth, and behaviour are identical.
    if (uEffect > 4.5 && uEffect < 5.5) {
        float i = 1.0 + (uIntensity - 1.0) * 0.45;
        vec3 l1 = leafLayer(p, vec2(56.0, 88.0) / i, 4.0, flow, vec2(3.3, 7.2), flow * 4.0) * 0.5;
        vec3 l2 = leafLayer(p, vec2(110.0, 160.0) / i, 6.0, flow, vec2(8.1, 2.6), flow * 8.0) * 0.8;
        vec3 l3 = leafLayer(p, vec2(200.0, 300.0) / i, 9.0, flow, vec2(5.7, 9.0), flow * 13.0) * 1.0;

        // Depth masks: each layer keeps its own shade after recoloring.
        float m1 = length(l1);
        float m2 = length(l2);
        float m3 = length(l3);
        vec3 leaves;
        if (uVariant > 0.5) {
            // Cherry blossom: the same tumbling leaves, recolored white-to-pink.
            vec3 petal1 = vec3(1.00, 0.88, 0.93);
            vec3 petal2 = vec3(0.96, 0.68, 0.80);
            vec3 petal3 = vec3(0.86, 0.50, 0.66);
            leaves = clamp(petal1 * m1 + petal2 * m2 + petal3 * m3, 0.0, 1.2);
        } else {
            leaves = clamp(l1 + l2 + l3, 0.0, 1.2);
        }

        float lum = clamp(length(leaves), 0.0, 1.0);
        // Evening ambient light: golden for autumn, a soft blossom tinge for cherry.
        vec3 amb = uVariant > 0.5 ? vec3(0.96, 0.88, 0.92) : vec3(0.82, 0.58, 0.30);
        vec3 col = amb * (0.25 + 0.45 * lum);
        col += leaves * 1.15;

        float alpha = clamp(lum * 0.85 + 0.03, 0.0, 1.0);
        fragColor = vec4(col, alpha * qt_Opacity);
        return;
    }

    // Aurora: a deep night sky with a single undulating curtain of light
    // hanging over the horizon, broken into vertical folds and a bright rim
    // like a real aurora, plus a few faint stars overhead. Intensity lifts the
    // curtain's brightness (and its reach of green-to-pink light).
    if (uEffect > 5.5 && uEffect < 6.5) {
        float i = 1.0 + (uIntensity - 1.0) * 0.45;
        vec2 n = p / uRes;

        // Faint twinkling stars scattered across the night sky.
        vec3 col = vec3(0.10, 0.13, 0.21) * 0.30;
        {
            vec2 sc2 = p / vec2(140.0, 140.0);
            vec2 sg2 = floor(sc2);
            vec2 sf2 = fract(sc2);
            vec2 rs2 = hash2(sg2 + vec2(51.0, 9.3));
            float has = step(0.965, rs2.x);
            vec2 off2 = (sf2 - 0.5) * 140.0;
            float sdot = 1.0 - smoothstep(0.0, 1.6, length(off2));
            float tw = 0.5 + 0.5 * vnoise(vec2(sg2.x * 0.7, flow * 0.15 + sg2.y * 0.9));
            col += vec3(0.9, 0.94, 1.0) * (has * sdot * tw) * 0.7;
        }

        // Curtain: an undulating lower edge, vertical folds, and a bright rim
        // along the edge where the light pools brightest. The audio level
        // (uAudio 0..1, smoothed) lifts the curtain and quickens its shimmer.
        float react = clamp(uAudio, 0.0, 1.0);
        float x = n.x * 6.2831;
        float edge = 0.42 - 0.05 * react
                   + 0.055 * sin(x * 1.0 + flow * (0.5 + 0.9 * react))
                   + 0.030 * sin(x * 3.4 + flow * (0.32 + 0.8 * react) + 2.1)
                   + 0.018 * sin(x * 8.6 + flow * (0.18 + 1.0 * react) + 4.7);
        float y = 1.0 - n.y;
        float d = y - edge;
        float fade = exp(-max(d, 0.0) * 9.0) * smoothstep(-0.05, 0.0, d);
        float w = sin(x * 3.0 + flow * (0.4 + 1.2 * react)) * 2.0
                + sin(x * 7.0 + flow * (0.55 + 1.4 * react)) * 1.3;
        float folds = 0.7 + 0.3 * sin(x * 26.0 + w + flow * (0.9 + 1.6 * react));
        float rim = exp(-abs(d) * 26.0) * 0.5;
        float band = clamp(fade * folds + rim, 0.0, 1.3);

        // Color climbs green near the edge to pink higher overhead, with a
        // slow horizontal sway in the green/teal mix.
        vec3 green = vec3(0.35, 0.85, 0.45);
        vec3 teal = vec3(0.25, 0.85, 0.70);
        vec3 pink = vec3(0.85, 0.50, 0.90);
        vec3 curtain = mix(green, teal, 0.4 + 0.4 * sin(x * 2.0 + flow * 0.35));
        curtain = mix(curtain, pink, smoothstep(0.40, 0.85, 1.0 - n.y));
        col += curtain * (band * 0.55 * i * (1.0 + 1.2 * react));

        float alpha = clamp(0.30 + band * 0.6 * (0.55 + 0.35 * i) * (1.0 + react), 0.0, 1.0);
        fragColor = vec4(col, alpha * qt_Opacity);
        return;
    }

    // Embers: sparse warm fire sparks drifting up from below the frame. Each is
    // a tiny bright core with a soft halo that rises, sways, and flickers on
    // its own. Intensity scales how many sparks hang in the air, speed how
    // fast they climb. The base stays clear so the wallpaper reads through.
    if (uEffect > 8.5 && uEffect < 9.5) {
        float i = 1.0 + (uIntensity - 1.0) * 0.5;
        float e1 = emberLayer(p, vec2(80.0, 110.0) / i, 2.4, flow, vec2(2.2, 9.4), flow * 0.6) * 0.7;
        float e2 = emberLayer(p, vec2(150.0, 200.0) / i, 3.3, flow, vec2(6.3, 3.7), flow * 1.1) * 0.9;
        float e3 = emberLayer(p, vec2(260.0, 340.0) / i, 4.35, flow, vec2(9.1, 6.2), flow * 1.7) * 1.0;
        float embers = clamp(e1 + e2 + e3, 0.0, 1.1);

        // Deep flame-ember orange, slightly yellow only in the hottest core.
        vec3 glow = vec3(1.0, 0.42, 0.08);
        vec3 hot = vec3(1.00, 0.72, 0.35);
        vec3 col = mix(glow, hot, smoothstep(0.3, 0.9, embers)) * embers;
        col *= 1.5;

        float alpha = clamp(embers * 0.95 + 0.02, 0.0, 1.0);
        fragColor = vec4(col, alpha * qt_Opacity);
        return;
    }

    // Bubbles: clear round bubbles rising through the water, each with a bright
    // rim and a specular highlight. The interior stays mostly clear so the
    // wallpaper shows through each bubble. Intensity scales how many bubbles
    // hang in the water, speed how fast they rise.
    if (uEffect > 9.5 && uEffect < 10.5) {
        float i = 1.0 + (uIntensity - 1.0) * 0.5;
        // Static stagger between layers — never a flow-scaled drift.
        vec2 b1 = bubbleLayer(p, 560.0 / i, 4.0, 9.0, 0.16, flow, vec2(4.2, 8.8), 0.0);
        vec2 b2 = bubbleLayer(p, 860.0 / i, 5.0, 14.0, 0.12, flow, vec2(6.1, 3.3), 9.0);
        vec2 b3 = bubbleLayer(p, 1250.0 / i, 6.0, 20.0, 0.09, flow, vec2(9.3, 5.1), 20.0);

        float vis = clamp(b1.x * 0.8 + b2.x * 0.9 + b3.x, 0.0, 1.5);
        float fill = clamp(b1.y * 0.8 + b2.y * 0.9 + b3.y, 0.0, 1.4);

        // Bright near-white rim and highlight over a faint cool tinted interior.
        vec3 col = vec3(0.90, 0.96, 1.0) * vis * 1.15;
        col += vec3(0.55, 0.75, 0.88) * fill * 0.35;

        float alpha = clamp((vis + fill) * 0.85, 0.0, 1.0);
        fragColor = vec4(col, alpha * qt_Opacity);
        return;
    }

    // Confetti: small bright paper rectangles fluttering down in a light
    // crosswind, spinning and thinning as they fall. Intensity scales how many
    // pieces are in the air, speed how fast they drop.
    if (uEffect > 10.5 && uEffect < 11.5) {
        float i = 1.0 + (uIntensity - 1.0) * 0.45;
        vec3 c1 = confettiLayer(p, vec2(48.0, 80.0) / i, 3.0, flow, vec2(6.6, 4.4), flow * 3.0) * 0.55;
        vec3 c2 = confettiLayer(p, vec2(96.0, 140.0) / i, 4.6, flow, vec2(2.2, 8.1), flow * 6.0) * 0.8;
        vec3 c3 = confettiLayer(p, vec2(170.0, 250.0) / i, 6.8, flow, vec2(9.4, 3.1), flow * 10.0) * 1.0;
        vec3 confetti = clamp(c1 + c2 + c3, 0.0, 1.2);

        float lum = clamp(length(confetti), 0.0, 1.0);
        // Faint cool backdrop so bright pieces pop, never a bright wash.
        vec3 col = vec3(0.10, 0.13, 0.22) * (0.18 + 0.25 * lum);
        col += confetti * 1.15;

        float alpha = clamp(lum * 0.8 + 0.05, 0.0, 1.0);
        fragColor = vec4(col, alpha * qt_Opacity);
        return;
    }

    // Caustics: the shifting light web you see on the bed of a shallow pool.
    // Three travelling waves cross to build a network of bright arcs that
    // shimmer and drift; the gaps stay clear so the wallpaper reads through.
    if (uEffect > 11.5 && uEffect < 12.5) {
        float b = 0.85 * (0.7 + (uIntensity - 1.0) * 0.4);
        vec2 q = p * 0.011 + vec2(13.0, 7.0);
        float t = flow * 0.9;
        // A mild warp makes the web bow and drift instead of sitting on a grid.
        q += 0.35 * vec2(vnoise(q * 1.4 + vec2(0.0, t * 0.6)),
                         vnoise(q * 1.4 + vec2(5.0, t * 0.6)));
        float a = sin(q.x * 1.7 + 2.1 * sin(q.y + t) + t);
        float c = sin(q.y * 1.3 + 1.9 * sin(q.x * 0.9 + t * 1.2) + t * 0.8);
        float e = sin((q.x + q.y) * 1.1 + 2.3 * sin((q.x - q.y) * 0.8 + t * 0.6) + t * 1.4);
        float web = a * c * e;
        web *= web;
        web *= web;

        // Sunlit water light over a faint cold undertone.
        vec3 col = vec3(0.45, 0.85, 1.00) * web * (1.6 * b);
        col += vec3(0.08, 0.16, 0.30) * b * 0.5;

        float alpha = clamp(web * b + 0.02, 0.0, 1.0);
        fragColor = vec4(col, alpha * qt_Opacity);
        return;
    }

    // Light Shafts: a fan of warm light beams streaming from a chosen corner of
    // the screen, like sunbeams falling through haze. uCorner picks the source
    // (0 TL, 1 TR, 2 BL, 3 BR), intensity lifts the brightness, and speed
    // steers how the beams sway and shimmer.
    if (uEffect > 12.5 && uEffect < 13.5) {
        float b = 0.7 * (0.6 + (uIntensity - 1.0) * 0.35);

        vec2 c = vec2(0.0);
        // atan2 of the corner diagonal is fixed per corner, so resolve it to a
        // constant instead of a normalize + atan2 in every fragment.
        float d = 0.7853982; // atan2(1, 1)
        if (uCorner >= 0.5 && uCorner < 1.5) {
            c = vec2(uRes.x, 0.0); d = 2.3561945; // atan2(1, -1)
        } else if (uCorner >= 1.5 && uCorner < 2.5) {
            c = vec2(0.0, uRes.y); d = -0.7853982; // atan2(-1, 1)
        } else if (uCorner >= 2.5) {
            c = vec2(uRes.x, uRes.y); d = -2.3561945; // atan2(-1, -1)
        }

        vec2 dv = p - c;
        float dist = length(dv);
        float da = atan(dv.y, dv.x) - d;
        // atan(sin,cos) is just the angle folded into [-PI,PI]; a mod is exact
        // and saves a second atan2 on every pixel.
        da = mod(da + 3.1415927, 6.2831853) - 3.1415927;

        // Bend the ray angles gently so beams curve like light through haze.
        // Straighter (higher uStraightness) beams bend and sway less.
        float wa = clamp(0.55 - 0.35 * uStraightness, 0.0, 0.6);
        float tadv = flow * mix(0.06, 0.015, clamp(wa / 0.55, 0.0, 1.0));
        float warp = wa * (vnoise(dv * 0.0018 + vec2(0.0, tadv)) - 0.5) * 2.0;
        float spread = 1.0 - smoothstep(0.28, 1.30, abs(da + warp));

        // Narrow alternating wedges across the fan.
        float beams = 0.5 + 0.5 * cos((da + warp) * 29.0);
        beams = pow(max(beams, 0.0), 1.8);

        // Brightest near the corner, fading out across the screen.
        float far = max(uRes.x, uRes.y);
        float fade = 1.0 - smoothstep(0.35, 1.05, dist / far);

        float shimmer = 0.8 + 0.2 * vnoise(vec2(dist * 0.004, flow * 0.08));

        float light = beams * spread * fade * shimmer;

        // Warm golden daylight.
        vec3 col = vec3(1.00, 0.94, 0.82) * light * (1.5 * b);

        float alpha = clamp(light * b + 0.03, 0.0, 1.0);
        fragColor = vec4(col, alpha * qt_Opacity);
        return;
    }

    // Effects not yet implemented render nothing.
    fragColor = vec4(0.0, 0.0, 0.0, 0.0);
}