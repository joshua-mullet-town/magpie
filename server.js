#!/usr/bin/env node
/**
 * Clip Grabber — a grab-and-stack video tool for Josh.
 *
 * Not an editor. You pick a LENGTH first (0.5 / 1 / 1.5 / 2s), point at a spot
 * in a source video, and take that chunk. Chunks stack into a timeline that
 * plays against one audio bed. Built because real editors are the wrong shape
 * for grabbing half-second pieces out of screen recordings.
 *
 * Zero npm dependencies — node stdlib + ffmpeg only.
 */
const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

const ROOT = __dirname;
const MEDIA = path.join(ROOT, 'media');
const SOURCES = path.join(MEDIA, 'sources');
const PROXIES = path.join(MEDIA, 'proxies');
const AUDIO = path.join(MEDIA, 'audio');
const OUT = path.join(MEDIA, 'out');
const PROJECTS = path.join(MEDIA, 'projects');
const STATE_FILE = path.join(MEDIA, 'project.json');   // the working document
const PORT = process.env.PORT || 4021;
/* Where a finished film ALSO lands, so Josh never has to go hunting for it.
   Josh, 2026-09-14: "what are they getting exported to? So annoying. Just make
   them export to the downloads."
   The copy in media/out stays — it's what the Exports drawer lists and what the
   /media/out/ URLs serve — but Downloads is the copy he actually looks for. */
const DOWNLOADS = path.join(require('os').homedir(), 'Downloads');

for (const d of [MEDIA, SOURCES, PROXIES, AUDIO, OUT, PROJECTS]) fs.mkdirSync(d, { recursive: true });

/* A name he can actually recognise in Downloads — "Magpie 2026-09-14 4.48 PM.mp4"
   beats "ramp-1789418932804.mp4". NEVER overwrites: if the name is taken, add " (2)",
   " (3)"… the way a browser would, so a re-export can't clobber a film he kept. */
/* `wanted` is the name he typed on the export screen (2026-09-15). When he gives one it
   is used verbatim (minus anything illegal in a filename); when he doesn't, fall back to
   the dated default. Either way the " (2)" collision guard below still applies, so
   exporting twice under the same name can never clobber the first film. */
async function uniqueDownloadPath(srcName, wanted) {
  const d = new Date();
  const p2 = n => String(n).padStart(2, '0');
  let h = d.getHours(); const ampm = h < 12 ? 'AM' : 'PM'; h = h % 12 || 12;
  const typed = String(wanted || '').trim()
    .replace(/\.mp4$/i, '')                 // he may or may not type the extension
    .replace(/[\/\\:*?"<>|\x00-\x1f]/g, '') // characters a filename cannot hold
    .slice(0, 80).trim();
  const base = typed || (`Magpie ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
             + ` ${h}.${p2(d.getMinutes())} ${ampm}`);
  const ext = path.extname(srcName) || '.mp4';
  for (let i = 1; i < 500; i++) {
    const name = i === 1 ? `${base}${ext}` : `${base} (${i})${ext}`;
    const full = path.join(DOWNLOADS, name);
    try { await fsp.access(full); } catch { return full; }   // free only if access THROWS
  }
  return path.join(DOWNLOADS, `${base} ${Date.now()}${ext}`);
}

/* ---------------- project state ---------------- */
const EMPTY = {
  sources: [], audio: [], grabLen: 1.0, grabRate: 1, name: 'Untitled',
  /* CHAPTERS. The ACTIVE chapter's payload is the top level of this object (sources,
     ramps, timeline, audio, mode, view…) — see the CHAPTERS block below for why.
     `chapters` holds only the PARKED ones. */
  chapters: [],        // parked chapters: [{id, title, ord, ...CHAPTER_KEYS}]
  chapterId: null,     // id of the live one (loadState assigns on first run)
  chapterTitle: 'Intro',
  chapterOrd: 0,       // where the live one sits in the strip
  mode: 'grab',        // 'grab' (chunks) | 'ramp' (real-time windows)
  timeline: [],        // GRAB mode output — chunks
  ramps: [],           // RAMP mode output — {id, sourceId, start, len} real-time windows
  transcript: [],      // {start, end, text} against the AUDIO BED — survives video changes
  burnSubs: false,     // burn the transcript into the export?
  /* WHERE HE WAS LOOKING — saved with the project, shared by phone and desktop.
     Josh, 2026-09-09: "it'd be really nice if everything was kind of saved in real
     time, so whenever I went back to that site it would pick up wherever I left off
     ... whether I'm on my phone or the machine, it should all be pulling from the
     same place." Position is part of the work, not a per-device preference. */
  view: {
    videoPos: 0,       // seconds along the CONTINUOUS input (all sources stapled)
    chunkStart: 0,     // where the pending chunk begins, same coordinates
    chunkLen: 2,       // its length
    audioPos: 0,       // seconds into the bed
    selected: null,    // id of the mark being edited, or null
    screen: 'input',   // 'input' | 'output'
    loopAudio: false,  // does the bed play along with the loop
  },
};
/* A FRESH COPY of EMPTY, never EMPTY itself. `{ ...EMPTY }` is a SHALLOW copy: the new
   state's `sources`, `audio`, `ramps`… arrays ARE EMPTY's arrays, so the first clip added
   after a Start over was pushed into EMPTY — and every later Start over handed the same
   filled arrays straight back. Start over never cleared anything (found 2026-09-28: on a
   fresh install, add a clip, Start over, the clip is still there). Always build from this. */
const freshEmpty = () => JSON.parse(JSON.stringify(EMPTY));
const projFile = (name) => path.join(PROJECTS, safeName(name) + '.json');
const safeName = (n) => (String(n || 'Untitled').trim().replace(/[^\w .\-]+/g, '_').slice(0, 60)) || 'Untitled';

/* ---------------- CHAPTERS ----------------
 * Josh, 2026-09-15: "I can only have one active chapter at a time, but when I'm in that
 * chapter, that chapter has its own movie assets, it has its own audio, and it just works
 * exactly like chapter one, but all this stuff is out of the way ... a way to keep things
 * separate but in the same project."
 *
 * THE DESIGN, and why it is this shape:
 * STATE stays EXACTLY what it always was — the live, active chapter, with `sources`,
 * `ramps`, `timeline`, `audio`, `mode`, `view` at the top level. Every existing reader
 * (rampPlan, renderRamp, renderTimeline, all ~100 STATE.x sites, and the browser's
 * `S = j`) therefore keeps working untouched and CANNOT drift out of sync with the
 * active chapter, because there is no second copy for it to disagree with.
 *
 * `STATE.chapters` holds ONLY the chapters that are not active — each a parked bundle of
 * the same keys. Switching = park the live keys into the outgoing chapter, then lift the
 * incoming chapter's keys up into STATE. That swap happens in exactly ONE function
 * (`switchChapter`) reading exactly ONE key list (`CHAPTER_KEYS`).
 *
 * ⚠️ THE TRAP THIS AVOIDS (two real bugs in this file today: a predicate copy-pasted so a
 * fix reached only some call sites, and a guard reading STATE.timeline while the work was
 * in STATE.ramps): if instead every call site had to ask "which chapter am I in?", that
 * question would be written ~100 times and a fix would reach some of them. Here it is
 * written ZERO times — the active chapter IS the state. Nothing downstream can forget.
 */
const CHAPTER_KEYS = ['sources', 'audio', 'timeline', 'ramps', 'transcript',
                      'mode', 'burnSubs', 'grabLen', 'grabRate', 'view'];
const chapterDefaults = () => {
  const d = {};
  for (const k of CHAPTER_KEYS) {
    const v = EMPTY[k];
    d[k] = (v && typeof v === 'object') ? JSON.parse(JSON.stringify(v)) : v;
  }
  return d;
};
/* Lift the active chapter's payload out of STATE — the parked form. */
function packChapter() {
  /* `ord` travels WITH the chapter, here — not set by each caller. It was left out
     once, and the live chapter then sorted as ord 0 and jumped to the front of the
     strip the moment a second chapter existed. One place to get it right. */
  const out = { id: STATE.chapterId, title: STATE.chapterTitle, ord: STATE.chapterOrd ?? 0 };
  for (const k of CHAPTER_KEYS) out[k] = STATE[k];
  return out;
}
/* Make `ch` the live one, dropping its payload onto STATE's top level. */
function unpackChapter(ch) {
  const d = chapterDefaults();
  for (const k of CHAPTER_KEYS) STATE[k] = (ch[k] !== undefined ? ch[k] : d[k]);
  STATE.chapterId = ch.id;
  STATE.chapterTitle = ch.title;
}
/* The whole chapter list, active one included, in order — for the UI strip.
   Built from the SAME packChapter() the swap uses, so the strip can never
   describe the active chapter differently from what a switch would park. */
function chapterList() {
  const live = packChapter();
  const all = [live, ...(STATE.chapters || [])];
  all.sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0));
  return all;
}
function chapterSummary(ch) {
  return {
    id: ch.id,
    title: ch.title,
    active: ch.id === STATE.chapterId,
    sources: (ch.sources || []).length,
    marks: ((ch.mode === 'grab') ? (ch.timeline || []) : (ch.ramps || [])).length,
    audio: (ch.audio || []).length,
    seconds: +((ch.audio || []).reduce((a, x) => a + (x.duration || 0), 0)).toFixed(1),
    mode: ch.mode || 'grab',
  };
}
function switchChapter(toId) {
  if (toId === STATE.chapterId) return true;
  const list = STATE.chapters || [];
  const i = list.findIndex(c => c.id === toId);
  if (i < 0) return false;
  const incoming = list[i];
  /* ORDER IS A PROPERTY OF THE CHAPTER, NOT OF BEING ACTIVE. Each keeps the `ord` it
     already had (packChapter carries the live one's out); only WHICH ONE IS LIVE
     changes. Get this wrong and the strip visibly reshuffles every time he switches —
     exactly what chapters are supposed to stop doing. */
  const outgoing = packChapter();         // already carries its own ord
  STATE.chapterOrd = incoming.ord ?? 0;   // the incoming one brings its own up
  list.splice(i, 1, outgoing);            // the parked one takes the slot the live one vacated
  const keepMode = outgoing.mode;          // the mode is the PROJECT's — it doesn't change on a switch
  unpackChapter(incoming);
  STATE.mode = keepMode || STATE.mode;
  STATE.chapters = list;
  return true;
}
/* 🎚 PER-MOMENT / PER-CHUNK RATE. Josh, 2026-09-24: "instead of making it always
   having to be real time... I can control the actual rate for the chunk... double time
   or half time." `len` stays what it always was — seconds of FOOTAGE (start → start+len
   in the clip). `rate` is how fast that footage plays (1 = real time, 2 = double, 0.5 =
   half). So the moment takes `len / rate` seconds of AUDIO. Every place that asks "how
   much of the audio / output does this occupy" must use outLen(); every place that asks
   "which footage" keeps using len. TWIN of app.js rateOf()/outLen(). */
function rateOf(x) { const r = +(x && x.rate); return (isFinite(r) && r > 0) ? Math.max(0.05, Math.min(20, r)) : 1; }
function outLen(x) { return (+(x && x.len) || 0) / rateOf(x); }
const cleanRate = v => { const r = Number(v); return (isFinite(r) && r > 0) ? +Math.max(0.05, Math.min(20, r)).toFixed(3) : null; };
function loadState() {
  let st;
  try { st = { ...freshEmpty(), ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; }
  /* First run (no project yet) must still get an active chapter, or export has nothing
     to act on and fails with "no chapters selected". Found testing a fresh install. */
  catch { return ensureChapters(freshEmpty()); }
  // ramps predating the audioAt anchor: place them in order rather than orphaning them
  let acc = 0;
  for (const r of (st.ramps || [])) {
    if (r.audioAt == null) { r.audioAt = +acc.toFixed(3); }
    acc = Math.max(acc, (r.audioAt || 0) + outLen(r));
  }
  return ensureChapters(st);
}
/* MIGRATION — a document made before chapters existed. Everything it holds IS the first
   chapter, so it simply becomes the active one: the keys are already at the top level in
   exactly the right place, and we only name them. Nothing moves, so nothing can be lost,
   and the very next export is byte-identical to the last one.
   ⚠️ EVERY path that puts a document into STATE must go through here — booting
   (loadState) AND opening a saved project. It lived only in loadState at first, and a
   pre-chapters project opened from the drawer landed with chapterId null: no active
   chapter at all, an empty strip, and every chapter call with nothing to act on. */
function ensureChapters(st) {
  if (!st.chapterId) {
    /* NOT id8() — that is a `const` arrow declared further down this file, and loadState
       runs at module load, before it is initialised (temporal dead zone -> the server
       would not boot at all). Same bytes, computed inline. */
    st.chapterId = crypto.randomBytes(6).toString('hex');
    st.chapterTitle = st.chapterTitle || 'Intro';
    st.chapterOrd = 0;
  }
  if (!Array.isArray(st.chapters)) st.chapters = [];
  /* GRAB chunks now carry WHERE THEY LAND in the audio (`audioAt`). Josh, 2026-09-23:
     he set the audio to 0.5s, marked, and the chunk landed at 0:00 — GRAB used to just
     stack chunks from the start and ignore LANDS AT. A chunk without one gets the spot
     it already played at when stacked, so every existing chapter plays exactly as it did. */
  for (const bk of [st, ...st.chapters]) {
    let acc = 0;
    for (const c of (bk.timeline || [])) {
      if (typeof c.audioAt !== 'number' || !isFinite(c.audioAt)) c.audioAt = +acc.toFixed(3);
      acc = c.audioAt + outLen(c);
    }
  }
  return st;
}
/* Where each GRAB chunk plays in the output: at its audioAt, in audio order. A chunk is
   cut short where the next one begins (the later one wins an overlap). Gaps between
   chunks hold the frame before them; the lead-in before the first holds its first frame.
   TWIN of app.js chunkPlaces() — keep the two identical. */
function chunkPlaces(timeline) {
  const list = (timeline || []).map((c, i) => ({ c, i, at: +c.audioAt || 0 }))
    .sort((a, b) => a.at - b.at || a.i - b.i);
  return list.map((p, k) => {
    const next = list[k + 1];
    const len = Math.max(0, Math.min(outLen(p.c), next ? next.at - p.at : outLen(p.c)));   // OUTPUT seconds
    return { c: p.c, i: p.i, at: p.at, len };
  });
}
const sortTimeline = () => { STATE.timeline = chunkPlaces(STATE.timeline).map(p => p.c); };
const bedTotal = () => (STATE.audio || []).reduce((a, x) => a + (x.duration || 0), 0);
function saveState(s) {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, STATE_FILE);           // atomic — never a half-written project
}
let STATE = loadState();

/* ---------------- ffmpeg helpers ---------------- */
function run(bin, args, { onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args);
    let err = '';
    p.stderr.on('data', d => { const s = d.toString(); err += s; if (onStderr) onStderr(s); });
    let out = '';
    p.stdout.on('data', d => { out += d.toString(); });
    p.on('close', code => code === 0 ? resolve(out) : reject(new Error(`${bin} exit ${code}: ${err.slice(-800)}`)));
    p.on('error', reject);
  });
}

async function probe(file) {
  const out = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-show_entries', 'stream=codec_type,width,height,r_frame_rate',
    '-of', 'json', file,
  ]);
  const j = JSON.parse(out);
  const v = (j.streams || []).find(s => s.codec_type === 'video');
  const a = (j.streams || []).find(s => s.codec_type === 'audio');
  let fps = null;
  if (v && v.r_frame_rate && v.r_frame_rate.includes('/')) {
    const [n, d] = v.r_frame_rate.split('/').map(Number);
    if (d) fps = n / d;
  }
  return {
    duration: parseFloat(j.format?.duration || 0),
    width: v?.width || null,
    height: v?.height || null,
    fps,
    hasVideo: !!v,
    hasAudio: !!a,
  };
}

/**
 * Proxy transcode. The load-bearing flag is `-g 15` at 30fps: a keyframe every
 * HALF SECOND. That is what makes a 0.5s grab land where he pointed instead of
 * snapping to the nearest keyframe seconds away.
 */
/* EVERY proxy lands on ONE canvas — 1280x720, 16:9 — letterboxed to preserve its own
   aspect ratio. Mixed dimensions silently corrupt the render: `concat -c copy` adopts
   the FIRST segment's size and squashes every later one, with no error whatsoever.
   (Josh, 2026-09-10, after recording at a different size: "I'd prefer to keep the size
   of the last video from here on out... get those first bits to take on the dimensions
   of the other.") `force_original_aspect_ratio=decrease` + `pad` = fit and centre. */
const CANVAS_W = 1280, CANVAS_H = 720;
const PROXY_ARGS = (input, output) => ([
  '-v', 'error', '-y', '-i', input,
  '-vf', `scale=${CANVAS_W}:${CANVAS_H}:force_original_aspect_ratio=decrease,` +
         `pad=${CANVAS_W}:${CANVAS_H}:(ow-iw)/2:(oh-ih)/2:color=black,` +
         `setsar=1,fps=30`,
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
  '-g', '15', '-keyint_min', '15', '-sc_threshold', '0',
  '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  '-an',                                   // source audio is never used; his bed is separate
  output,
]);

const jobs = new Map();   // id -> {status, pct, error}

/** ffmpeg spews its whole build config on error; keep the last useful line only,
 *  and strip control characters so the state JSON can never be corrupted by it. */
function tidyErr(e) {
  const raw = String(e && e.message || e);
  const lines = raw.split('\n')
    .map(l => l.trim())
    .filter(l => l && !/^(configuration:|lib(av|sw)|built with|ffmpeg version|\s*Copyright)/.test(l));
  const msg = lines.slice(-2).join(' — ') || raw.slice(-200);
  return msg.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300);
}

/* 📡 PUSH to open pages (Server-Sent Events) — no polling. Josh, 2026-09-26: "it needs to be
   immediate... it can't be this polling thing." A page holds GET /api/events open; the server
   writes one line the instant a clip is added or finishes processing. */
const sseClients = new Set();
function pushEvent(type, data) {
  const line = `event: ${type}\ndata: ${JSON.stringify(data || {})}\n\n`;
  for (const r of sseClients) { try { r.write(line); } catch { sseClients.delete(r); } }
}
setInterval(() => { for (const r of sseClients) { try { r.write(': keepalive\n\n'); } catch { sseClients.delete(r); } } }, 25000);

/* A video file already sitting in SOURCES as `srcFile` → a clip in the open chapter, with
   its proxy started immediately. Shared by the upload button and the Inbox watcher. */
async function addSourceFile(id, srcFile, name, bytes, at) {
  const info = await probe(path.join(SOURCES, srcFile));
  if (!info.hasVideo) {
    await fsp.unlink(path.join(SOURCES, srcFile)).catch(() => {});
    return { error: 'that file has no video track' };
  }
  const proxyFile = `${id}.mp4`;
  const entry = { id, name, file: srcFile, proxy: proxyFile,
                  duration: info.duration, width: info.width, height: info.height,
                  fps: info.fps, bytes, ready: false };
  if (Number.isInteger(at) && at >= 0 && at < STATE.sources.length) STATE.sources.splice(at, 0, entry);
  else STATE.sources.push(entry);
  saveState(STATE);
  pushEvent('sources', { added: id, name });
  makeProxy(id, path.join(SOURCES, srcFile), path.join(PROXIES, proxyFile), info.duration)
    .then(async (ok) => {
      const e = STATE.sources.find(x => x.id === id);
      if (!e) return;
      if (!ok) { e.ready = false; e.failed = true; saveState(STATE); return; }
      // trust the PROXY's own duration — it is what the browser actually plays
      try { const pi = await probe(path.join(PROXIES, proxyFile)); if (pi.duration) e.duration = pi.duration; } catch {}
      e.ready = true; e.failed = false;
      saveState(STATE);
      pushEvent('sources', { ready: id, name: e.name });
    });
  return { entry };
}

/* 📥 THE INBOX. Josh, 2026-09-26: "I'll use command shift five to start recording the
   screen... those files getting saved to... my downloads directory. It'd be kind of nice if
   they just automatically got sent into a spot where they would be being uploaded into
   magpie... I will sometimes forget to go get it processing immediately."
   Cmd-Shift-5 saves into ~/Movies/Magpie Inbox; every few seconds Magpie picks up any
   finished video there (size unchanged across two looks), adds it to the chapter that is
   OPEN, and starts processing it. The original is never deleted: it moves to Inbox/Imported
   (hard-linked into media/sources, so no second copy on disk). */
/* Opt-in: set MAGPIE_INBOX to a folder (e.g. ~/Movies/Magpie Inbox) to enable it. */
const INBOX = process.env.MAGPIE_INBOX || null;
const INBOX_DONE = INBOX && path.join(INBOX, 'Imported');
const inboxSeen = new Map();          // file -> size at the last look
let inboxBusy = false;
async function inboxTick() {
  if (inboxBusy) return; inboxBusy = true;
  try {
    await fsp.mkdir(INBOX_DONE, { recursive: true });
    for (const f of await fsp.readdir(INBOX)) {
      if (f.startsWith('.') || !/\.(mov|mp4|m4v)$/i.test(f)) continue;
      const full = path.join(INBOX, f);
      let st; try { st = await fsp.stat(full); } catch { continue; }
      if (!st.isFile() || !st.size) continue;
      /* FINISHED = nothing has it open any more (screencapture closes it the instant you hit
         stop). `lsof -t` exits 1 with no output when no process holds the file. Fallback, if
         lsof itself fails: the old "same size on two looks". */
      let open = null;
      try { await run('lsof', ['-t', '--', full]); open = true; }
      catch (e) { open = (e && e.code === 1) || /exit(ed)? (with )?(code )?1\b/.test(String(e && e.message)) ? false : null; }
      if (open === true) continue;
      if (open === null) { if (inboxSeen.get(f) !== st.size) { inboxSeen.set(f, st.size); continue; } }
      inboxSeen.delete(f);
      const id = id8(), srcFile = `${id}${path.extname(f).toLowerCase() || '.mov'}`;
      try { await fsp.link(full, path.join(SOURCES, srcFile)); }
      catch { await fsp.copyFile(full, path.join(SOURCES, srcFile)); }
      let dest = path.join(INBOX_DONE, f);
      if (fs.existsSync(dest)) dest = path.join(INBOX_DONE, `${path.parse(f).name} (${id})${path.extname(f)}`);
      await fsp.rename(full, dest);
      const r = await addSourceFile(id, srcFile, safe(f), st.size, NaN);
      console.log(`[inbox] ${f} -> ${r.error ? 'REJECTED: ' + r.error : 'clip ' + id + ' in "' + (STATE.chapterTitle || '?') + '"'}`);
    }
  } catch (e) { if (e.code !== 'ENOENT') console.error('[inbox]', e.message); }
  finally { inboxBusy = false; }
}
if (INBOX) {
  fs.mkdirSync(INBOX_DONE, { recursive: true });
  // the folder TELLS us when something changes (fs.watch); the slow sweep is only a safety net
  let inboxKick = null;
  try { fs.watch(INBOX, () => { clearTimeout(inboxKick); inboxKick = setTimeout(inboxTick, 250); }); }
  catch (e) { console.error('[inbox] watch failed, sweeping only:', e.message); }
  setInterval(inboxTick, 1000);   // closing a file fires no watch event, so this catches "stop"
}

async function makeProxy(id, srcPath, proxyPath, durationHint) {
  jobs.set(id, { status: 'working', pct: 0 });
  try {
    const args = PROXY_ARGS(srcPath, proxyPath);
    args.splice(2, 0, '-progress', 'pipe:2', '-nostats');   // after '-v error', before '-y'
    await run('ffmpeg', args, {
      onStderr: (s) => {
        const m = /out_time_us=(\d+)|out_time_ms=(\d+)/.exec(s);
        if (m && durationHint) {
          const us = Number(m[1] || m[2]);
          const pct = Math.min(99, Math.round((us / 1e6) / durationHint * 100));
          if (pct >= 0) jobs.set(id, { status: 'working', pct });
        }
      },
    });
    jobs.set(id, { status: 'done', pct: 100 });
    return true;
  } catch (e) {
    jobs.set(id, { status: 'error', pct: 0, error: tidyErr(e) });
    return false;
  }
}

/* ---------------- http plumbing ---------------- */
function send(res, code, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
  res.end(data);
}
function sendJSON(res, obj, code = 200) { send(res, code, obj); }

function serveFile(req, res, file, type) {
  let st;
  try { st = fs.statSync(file); } catch { return send(res, 404, { error: 'not found' }); }
  const range = req.headers.range;
  if (range) {                                   // range support = scrubbing works at all
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m[1] ? parseInt(m[1]) : 0;
    let end = m[2] ? parseInt(m[2]) : st.size - 1;
    if (isNaN(start) || start < 0) start = 0;
    if (isNaN(end) || end >= st.size) end = st.size - 1;
    if (start > end) return send(res, 416, { error: 'bad range' });
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Range': `bytes ${start}-${end}/${st.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
    });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(file).pipe(res);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 4 * 1024 * 1024 * 1024) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const MIME = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4a': 'audio/mp4',
               '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.html': 'text/html; charset=utf-8',
               '.js': 'text/javascript', '.css': 'text/css' };
const id8 = () => crypto.randomBytes(6).toString('hex');
const safe = (n) => (n || 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 120);

/* ---------------- transcript ----------------
 * Josh, 2026-09-10: "how hard or easy would it be to pair an actual transcription to
 * the audio, independent of which videos I choose behind it... in my export actually
 * have a transcription on it based not on the video, just on the audio?"
 * It belongs to the BED, so it survives every video change, reorder and removal.
 * Local whisper on :8178 — ~6s for a 46s bed. Stored as {start, end, text} on STATE.
 */
const WHISPER = process.env.MAGPIE_WHISPER_URL || 'http://localhost:8178/inference';
/* Whisper mishears the words Josh says most. Fixed BEFORE he ever sees them. */
const FIXUPS = [
  [/\bcl(?:ou|au)d\s+code\b/gi, 'Claude Code'],
  [/\bclod\s+code\b/gi, 'Claude Code'],
  [/\bclawed\s+code\b/gi, 'Claude Code'],   // heard 2026-09-28 on a clean TTS voiceover
  [/\bchat\s*g[bp]t\b/gi, 'ChatGPT'],
  [/\bco[- ]?pilot\b/gi, 'Copilot'],
  [/\bcursor\b/g, 'Cursor'],
];
const fixText = t => FIXUPS.reduce((a, [re, to]) => a.replace(re, to), String(t || '')).trim();

/* The transcript's timings are AUDIO timings — and the output IS the audio's length,
   so they are already output timings. No remapping needed however the video is cut. */
function transcriptToSrt() {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = t => { const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60),
                       sec = Math.floor(t % 60), ms = Math.round((t - Math.floor(t)) * 1000);
                       return `${pad(h)}:${pad(m)}:${pad(sec)},${pad(ms, 3)}`; };
  return (STATE.transcript || []).map((x, i) =>
    `${i + 1}\n${stamp(x.start)} --> ${stamp(x.end)}\n${x.text}\n`).join('\n');
}

/* Karaoke subtitles: the word being said is lit, the rest of the line is dimmer.
   Josh, 2026-09-21: "is there a common technique for basically getting whatever word
   is being said to pop a little bit more". There is — it's how karaoke tracks are
   timed, and ffmpeg renders it natively from ASS. Needs per-word timings, which
   transcribeBed now stores. Falls back to plain lines for any segment without them. */
/* The words of ONE caption line, each with a time. Uses whisper's real per-word timings
   when they still match the line's text; if he has edited the line (or it has no word
   timings at all), spreads HIS words across the line by length — so every line lights
   word by word either way, and an edited line never shows words he took out. */
function lineWords(seg) {
  const text = String(seg.text || '').trim();
  const toks = text.split(/\s+/).filter(Boolean);
  const ws = (seg.words || []).filter(w => w && String(w.word || '').trim());
  const norm = x => String(x).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  if (ws.length && ws.length === toks.length
      && ws.every((w, i) => norm(w.word) === norm(toks[i]))) {
    return ws.map((w, i) => ({ word: toks[i], start: +w.start, end: +w.end }));
  }
  if (!toks.length) return [];
  const span = Math.max(0.01, seg.end - seg.start);
  const weight = toks.map(t => t.length + 1);
  const sum = weight.reduce((a, b) => a + b, 0);
  let t = seg.start;
  return toks.map((w, i) => { const d = span * weight[i] / sum;
    const o = { word: w, start: +t.toFixed(3), end: +(t + d).toFixed(3) }; t += d; return o; });
}

/* Karaoke, three states per word — said (white), SAYING (amber, a touch bigger),
   not yet said (white, faded). Josh, 2026-09-23: "making the transcription at the
   bottom pop a little bit more... it's not very pretty and it's not by word."
   ASS \k only has two states, so each word gets its own short event with the whole
   line re-drawn — exact, and it matches the preview in the app one to one. */
function transcriptToAss(opts = {}) {
  const said   = opts.said   || '&H00FFFFFF';   // already spoken  (white)
  const unsaid = opts.unsaid || '&H004FA8E0';   // not yet said    (amber)
  const size   = opts.size   || Math.round((opts.height || 1080) * 0.042);
  const cs = t => Math.max(0, Math.round(t * 100));
  const ts = t => {
    const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), sec = t % 60;
    return `${h}:${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`;
  };
  const esc = x => String(x).replace(/[{}\\]/g, '').replace(/\r?\n/g, ' ');
  void said; void unsaid; void cs;
  /* THE WORD BEING SAID CHANGES COLOUR — NOTHING ELSE CHANGES. Josh, 2026-09-26, on the
     amber box: "too dramatic... the words come so fast it actually makes it harder to read...
     the text goes from white to black... no outline... then the gray is hard to read."
     History: v1 grew the word (\\fscx112) → it collided and the line shifted; v2 put it on an
     amber box with dark text → three big changes per word, flickering at ~4 words/second, and
     the dimmed not-yet-said words were hard to read. v3 = the readable standard: EVERY word
     solid white with the same outline at all times (nothing dimmed, nothing moves, nothing
     resizes); only the current word's fill turns amber. One small signal per word. */
  const NOW  = '{\\c&H0050C8FF&}';        // amber fill, same outline + size as the rest
  const BASE = '{\\c&H00FFFFFF&}';        // white
  const lines = [];
  for (const seg of (STATE.transcript || [])) {
    const ws = lineWords(seg);
    if (!ws.length) continue;
    ws.forEach((w, i) => {
      const from = i === 0 ? seg.start : w.start;
      const to = i === ws.length - 1 ? seg.end : ws[i + 1].start;
      if (!(to > from)) return;
      const body = ws.map((x, j) => (j === i ? NOW : BASE) + esc(x.word)).join(' ');
      lines.push(`Dialogue: 0,${ts(from)},${ts(to)},K,,0,0,0,,${body}`);
    });
  }
  /* Without PlayRes the renderer guesses, and margins/'wrap' land nowhere near right. */
  const W = opts.width || 1920, H = opts.height || 1080;
  return `[Script Info]
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
PlayResX: ${W}
PlayResY: ${H}

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: K,Helvetica,${size},${said},${unsaid},&H00000000,&H90000000,-1,0,0,0,100,100,0,0,1,2.5,1,2,90,90,30,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
${lines.join('\n')}
`;
}

/* Put whisper's word TIMES onto HIS words. Aligns the whole chapter's text against
   whisper's word stream (longest common subsequence on normalised words) — matching
   per line by time misplaced the words at every line boundary. A word whisper heard
   differently gets a time interpolated between its matched neighbours, kept inside
   its own line. Writes seg.words = his tokens, one-to-one, so lineWords uses them. */
function alignWords(tr, words) {
  const norm = x => String(x).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const T = [];
  tr.forEach((seg, si) => String(seg.text || '').trim().split(/\s+/).filter(Boolean)
    .forEach(tok => T.push({ si, tok, n: norm(tok), start: null, end: null })));
  const W = words.map(w => ({ ...w, n: norm(w.word) }));
  const n = T.length, m = W.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    L[i][j] = T[i].n && T[i].n === W[j].n ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  let matched = 0;
  for (let i = 0, j = 0; i < n && j < m;) {
    if (T[i].n && T[i].n === W[j].n) { T[i].start = W[j].start; T[i].end = W[j].end; matched++; i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++;
  }
  // a matched time must sit inside its own line, or it's a mis-match — drop it
  for (const t of T) { const seg = tr[t.si];
    if (t.start != null && (t.start < seg.start - 0.3 || t.start > seg.end + 0.3)) { t.start = t.end = null; matched--; } }
  // fill the gaps: spread unmatched words between the neighbours, inside their line
  tr.forEach((seg, si) => {
    const ts = T.filter(t => t.si === si);
    let i = 0;
    while (i < ts.length) {
      if (ts[i].start != null) { i++; continue; }
      let j = i; while (j < ts.length && ts[j].start == null) j++;
      const from = i > 0 ? ts[i - 1].end : seg.start;
      const to = j < ts.length ? ts[j].start : seg.end;
      const lo = Math.max(seg.start, Math.min(from, seg.end)), hi = Math.max(lo + 0.01, Math.min(seg.end, to));
      const wt = ts.slice(i, j).map(t => t.tok.length + 1), sum = wt.reduce((a, b) => a + b, 0);
      let t0 = lo;
      for (let k = i; k < j; k++) { const d = (hi - lo) * wt[k - i] / sum;
        ts[k].start = +t0.toFixed(3); ts[k].end = +(t0 + d).toFixed(3); t0 += d; }
      i = j;
    }
    for (let k = 1; k < ts.length; k++) if (ts[k].start < ts[k - 1].start) ts[k].start = ts[k - 1].start;
    seg.words = ts.map(t => ({ word: t.tok, start: t.start, end: Math.max(t.start, t.end) }));
  });
  return { words: n, matchedToWhisper: matched };
}

/* Whisper the given bed and return its WORDS (merged like transcribeBed does). */
async function whisperWords(audioList) {
  const work = path.join(OUT, 'ww-' + id8());
  await fsp.mkdir(work, { recursive: true });
  try {
    const list = path.join(work, 'a.txt');
    await fsp.writeFile(list, audioList.map(a =>
      `file '${path.join(AUDIO, a.file).replace(/'/g, "'\\''")}'`).join('\n'));
    const wav = path.join(work, 'bed.wav');
    await run('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list,
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
    const form = new FormData();
    form.append('file', new Blob([await fsp.readFile(wav)]), 'bed.wav');
    form.append('response_format', 'verbose_json');
    const r = await fetch(WHISPER, { method: 'POST', body: form });
    if (!r.ok) throw new Error(`whisper said ${r.status}`);
    const j = await r.json();
    const out = [];
    for (const x of (j.segments || [])) for (const w of (x.words || [])) {
      const raw = String(w.word ?? ''), bare = raw.trim();
      if (!bare) continue;
      if (out.length && (!/[\p{L}\p{N}]/u.test(bare) || !/^\s/.test(raw))) {
        out[out.length - 1].word += bare; out[out.length - 1].end = +(+w.end).toFixed(2); continue;
      }
      out.push({ word: bare, start: +(+w.start).toFixed(2), end: +(+w.end).toFixed(2) });
    }
    return out.map(w => ({ ...w, word: fixText(w.word) }));
  } finally { await fsp.rm(work, { recursive: true, force: true }); }
}

async function transcribeBed(onProgress) {
  if (!STATE.audio.length) throw new Error('no audio bed to transcribe');
  const work = path.join(OUT, 'tr-' + id8());
  await fsp.mkdir(work, { recursive: true });
  try {
    // one 16k mono WAV of the WHOLE bed, in order — whisper takes nothing else
    const list = path.join(work, 'a.txt');
    await fsp.writeFile(list, STATE.audio.map(a =>
      `file '${path.join(AUDIO, a.file).replace(/'/g, "'\\''")}'`).join('\n'));
    const wav = path.join(work, 'bed.wav');
    await run('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list,
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
    if (onProgress) onProgress(35);

    const buf = await fsp.readFile(wav);
    const form = new FormData();
    form.append('file', new Blob([buf]), 'bed.wav');
    form.append('response_format', 'verbose_json');
    const r = await fetch(WHISPER, { method: 'POST', body: form });
    if (!r.ok) throw new Error(`whisper said ${r.status}`);
    const j = await r.json();
    if (onProgress) onProgress(85);

    /* Keep the PER-WORD timings whisper already gives us — karaoke subtitles need
       them, and re-asking for them later would mean transcribing twice.
       Whisper splits some words ("Cla"+"ude") and emits punctuation as its own
       token; both would get their own highlight, so glue them back on here. */
    const mergeWords = ws => {
      const out = [];
      for (const w of (ws || [])) {
        const raw = String(w.word ?? '');
        const bare = raw.trim();
        if (!bare) continue;
        const isPunct = !/[\p{L}\p{N}]/u.test(bare);
        const continues = !/^\s/.test(raw);
        if (out.length && (isPunct || continues)) {
          out[out.length - 1].word += bare;
          out[out.length - 1].end = +(+w.end).toFixed(2);
          continue;
        }
        out.push({ word: bare, start: +(+w.start).toFixed(2), end: +(+w.end).toFixed(2) });
      }
      return out;
    };
    const segs = (j.segments || [])
      .map(x => {
        const words = mergeWords(x.words).map(w => ({ ...w, word: fixText(w.word) }));
        return { start: +(+x.start).toFixed(2), end: +(+x.end).toFixed(2),
                 text: fixText(x.text), words };
      })
      .filter(x => x.text && isFinite(x.start) && isFinite(x.end) && x.end > x.start);
    STATE.transcript = segs;
    saveState(STATE);
    if (onProgress) onProgress(100);
    return segs;
  } finally { await fsp.rm(work, { recursive: true, force: true }); }
}

/* ---------------- ramp plan ----------------
 * He marks windows that must play at REAL speed. Everything else is squeezed so the
 * whole video lands on the audio's length. This computes that squeeze factor and
 * says plainly when it is impossible (real-time alone already exceeds the audio).
 */
/* 🚨 THE ONE ANSWER TO "IS THIS MOMENT IN THE FILM?" on the server — the twin of the
   client's rampInVideo(). A moment on a switched-off clip, a deleted clip, or footage
   trimmed away is SHELVED: it keeps its place on screen and takes part in NOTHING.
   Josh, 2026-09-22: "If I'm not including that video, it shouldn't consider it
   an interference... if [a clip] has a slowdown on it, it's not considered in the
   collision calculations." The plan's own ordering walk already skipped shelved marks,
   but two SUMS right beside it did not: `realTotal` (real-time already spent — feeds
   ok/why and the speed header) and the default landing spot for a new mark in POST
   /api/ramp. Both counted every mark ever made. One predicate now; use it, never
   STATE.ramps raw, anywhere a moment's time is being SPENT. */
function markInFilm(r) {
  const s = STATE.sources.find(x => x.id === r.sourceId);
  if (!s || s.off) return false;
  return r.start + r.len > useIn(s) - 0.01 && r.start < useOut(s) + 0.01;
}

/* THE WHOLE MOMENT STAYS INSIDE THE AUDIO. Every create and every edit — from the
   main page, the edit screen, the moment map drag, a suggested fix — passes through
   here, so the rule lives in ONE place instead of in each screen's buttons. It lands
   flush with the end at most; lengthening at the end slides it earlier. */
function clampToAudio(r) {
  const aTot = STATE.audio.reduce((a, x) => a + (x.duration || 0), 0);
  if (!aTot) return;
  if (outLen(r) > aTot) r.len = +(aTot * rateOf(r)).toFixed(3);   // its AUDIO span must fit
  r.audioAt = +Math.max(0, Math.min(aTot - outLen(r), +r.audioAt || 0)).toFixed(3);
}

/* ---------------- a bed's LAYOUT: its original audio + silences ----------------
   A bed is its untouched original (`src`) plus silences: `padBefore` (at 0), `gaps`
   (anywhere, each {id, at: seconds in the ORIGINAL, dur}) and `padAfter` (at the end).
   The playable file is rebuilt from the original every time, so any change is lossless,
   and everything else (playback, plan, captions, output, export) just reads one ordinary
   file. TWIN of app.js bedGaps()/gapOutStart() — keep them identical. */
function bedGaps(a) {
  const srcDur = a.srcDuration ?? a.duration ?? 0;
  const g = [];
  if ((+a.padBefore || 0) > 0) g.push({ id: 'before', at: 0, dur: +a.padBefore, ord: 0 });
  for (const x of (a.gaps || [])) g.push({ id: x.id, at: Math.max(0, Math.min(srcDur, +x.at || 0)), dur: +x.dur || 0, ord: 1 });
  if ((+a.padAfter || 0) > 0) g.push({ id: 'after', at: srcDur, dur: +a.padAfter, ord: 2 });
  return g.filter(x => x.dur > 0).sort((p, q) => p.at - q.at || p.ord - q.ord);
}
// where a silence STARTS in the bed's playable file
function gapOutStart(gaps, id) {
  let o = 0;
  for (const g of gaps) { if (g.id === id) return g.at + o; o += g.dur; }
  return null;
}
// original second -> playable second (a silence AT that point comes first)
function bedToOut(gaps, t) {
  let o = t;
  for (const g of gaps) if (g.at <= t + 1e-9 && g.id !== 'after') o += g.dur;
  return o;
}
// playable second -> original second, or which silence it sits inside and how far in
function bedInverse(gaps, x) {
  let co = 0, cg = 0;                        // playable cursor, original cursor
  for (const g of gaps) {
    const seg = g.at - cg;
    if (x < co + seg) return { orig: cg + (x - co) };
    co += seg; cg = g.at;
    if (x < co + g.dur) return { orig: g.at, gap: g.id, off: x - co };
    co += g.dur;
  }
  return { orig: cg + (x - co) };
}
async function relayoutBed(a, opts) {
  if (!a.src) { a.src = a.file; a.srcDuration = a.duration; }     // first change: remember the original
  const oldGaps = bedGaps(a), oldDur = a.duration || 0;
  const next = { ...a, padBefore: +opts.before || 0, padAfter: +opts.after || 0,
                 gaps: (opts.gaps || []).map(g => ({ id: g.id, at: +(+g.at).toFixed(3), dur: +(+g.dur).toFixed(2) })) };
  const newGaps = bedGaps(next);
  const srcPath = path.join(AUDIO, a.src);
  let file = a.src, dur = a.srcDuration;
  if (newGaps.length) {
    file = `${a.id}-lay-${Date.now()}${path.extname(a.src) || '.m4a'}`;
    // content pieces and silences, in order, all normalised to one format, then joined
    const parts = [], labels = [];
    let cg = 0, k = 0;
    const fmtN = 'aformat=sample_rates=48000:channel_layouts=stereo';
    for (const g of newGaps) {
      if (g.at - cg > 0.001) { parts.push(`[0:a]atrim=${cg.toFixed(4)}:${g.at.toFixed(4)},asetpts=PTS-STARTPTS,${fmtN}[p${k}]`); labels.push(`[p${k++}]`); }
      parts.push(`anullsrc=r=48000:cl=stereo,atrim=0:${g.dur.toFixed(4)},asetpts=PTS-STARTPTS,${fmtN}[p${k}]`); labels.push(`[p${k++}]`);
      cg = g.at;
    }
    if (a.srcDuration - cg > 0.001) { parts.push(`[0:a]atrim=start=${cg.toFixed(4)},asetpts=PTS-STARTPTS,${fmtN}[p${k}]`); labels.push(`[p${k++}]`); }
    const fc = parts.join(';') + ';' + labels.join('') + `concat=n=${labels.length}:v=0:a=1[out]`;
    try {
      await run('ffmpeg', ['-v', 'error', '-y', '-i', srcPath, '-filter_complex', fc, '-map', '[out]',
                           '-c:a', 'aac', '-b:a', '192k', path.join(AUDIO, file)]);
    } catch (e) { throw new Error(`could not rebuild the audio: ${tidyErr(e)}`); }
    const info = await probe(path.join(AUDIO, file));
    if (!info.duration) throw new Error('the rebuilt audio came out unreadable — nothing changed');
    dur = info.duration;
  }
  /* Everything pinned to AUDIO time rides along: moments, GRAB chunks, captions + words.
     Earlier beds: untouched. Later beds: the whole change. This bed: re-mapped through
     the old layout and back out through the new one — something sitting INSIDE a
     silence keeps its distance from that silence's start. */
  let base = 0;
  for (const x of STATE.audio) { if (x.id === a.id) break; base += x.duration || 0; }
  const dTotal = dur - oldDur;
  const shift = t => {
    if (!isFinite(t) || t < base - 0.001) return t;
    if (t >= base + oldDur - 0.001) return +(t + dTotal).toFixed(3);
    const hit = bedInverse(oldGaps, t - base);
    let local;
    if (hit.gap && newGaps.find(g => g.id === hit.gap)) {
      const g = newGaps.find(x => x.id === hit.gap);
      local = gapOutStart(newGaps, g.id) + Math.min(hit.off, g.dur);
    } else local = bedToOut(newGaps, hit.orig);
    return +(base + local).toFixed(3);
  };
  for (const r of STATE.ramps) r.audioAt = shift(+r.audioAt || 0);
  for (const c of (STATE.timeline || [])) if (typeof c.audioAt === 'number') c.audioAt = shift(c.audioAt);
  for (const seg of (STATE.transcript || [])) {
    seg.start = shift(seg.start); seg.end = shift(seg.end);
    for (const w of (seg.words || [])) { w.start = shift(w.start); w.end = shift(w.end); }
  }
  if (a.file !== a.src && a.file !== file) await fsp.unlink(path.join(AUDIO, a.file)).catch(() => {});
  a.file = file; a.duration = dur;
  a.padBefore = next.padBefore; a.padAfter = next.padAfter; a.gaps = next.gaps;
  saveState(STATE);
}
function rampPlan() {
  const vidTotal = STATE.sources.reduce((a, s) => a + useLen(s), 0);
  const audioTotal = STATE.audio.reduce((a, x) => a + (x.duration || 0), 0);
  const realTotal = STATE.ramps.filter(markInFilm).reduce((a, r) => a + outLen(r), 0);   // audio they occupy

  /* EACH MARK IS PINNED TO A MOMENT IN THE AUDIO (`audioAt`), and the video before
     it is compressed to arrive exactly there. Josh, 2026-09-09:
       "the chunk aligns with the video so that everything that happens in front of
        that audio moment is the part that speeds up... I should see pretty much all
        the video condense within like the first five seconds of the film."
     The old model computed ONE global speed spread evenly over everything, so a mark
     near the END of the video necessarily landed near the end of the AUDIO — he could
     not put it at 6s. Now the timeline is a sequence of gaps between pinned marks, and
     EACH GAP gets its own speed. */
  /* r.start is a position INSIDE its file, so a trimmed head shifts it back onto the
     continuous line. A mark that now falls outside the kept range simply isn't in the
     video any more — drop it from the plan rather than let it point at cut footage. */
  const marks = STATE.ramps
    .map(r => {
      if (!markInFilm(r)) return { ...r, srcAt: NaN };   // shelved: sits out entirely
      const s = STATE.sources.find(x => x.id === r.sourceId);
      return { ...r, srcAt: srcOffset(r.sourceId) + (r.start - useIn(s)) };
    })
    .filter(m => isFinite(m.srcAt) && m.srcAt >= -0.01)
    .sort((a, b) => (a.audioAt ?? 0) - (b.audioAt ?? 0));

  const spans = [];            // one per gap: source seconds -> output seconds
  let srcCur = 0, outCur = 0, impossible = null;
  for (const m of marks) {
    const aAt = (m.audioAt != null) ? m.audioAt : outCur;
    const gapOut = aAt - outCur;                 // audio seconds available before it
    const gapSrc = m.srcAt - srcCur;             // video seconds to fit in them
    if (gapOut < -0.01 || gapSrc < -0.01) { impossible = 'two moments overlap — move one'; break; }
    /* 🚨 NO AUDIO BEFORE A MOMENT? SKIP THAT VIDEO. DO NOT REFUSE.
       Josh, 2026-09-22, after I defended this refusal three times:
         "why would we not just leave out the video that happened before it? ... This is
          DESIGNED to speed up the portions that I don't have selected... for it to say,
          well, I'm not going to be able to cram 25 seconds of video into this 0.1 second
          of audio. My question is, why not? Like that's its whole job."
       He is right on both counts. The renderer speeds any span with `setpts=PTS/speed`,
       so this was never a physical limit — `gapOut <= 0.01` was a GUARD I kept
       explaining instead of removing. And when there is genuinely no audio to play the
       preceding video in, the obvious behaviour is the one he asked for: leave that
       video out and start on the moment. A `skip` span renders nothing, so the film
       simply opens where he pointed. Nothing is deleted; the clips are untouched. */
    if (gapSrc > 0.01 && gapOut <= 0.01) {
      spans.push({ kind: 'skip', srcFrom: srcCur, srcTo: m.srcAt,
                   outFrom: outCur, outTo: aAt, speed: null });
    } else {
      spans.push({ kind: 'filler', srcFrom: srcCur, srcTo: m.srcAt, outFrom: outCur, outTo: aAt,
                   speed: (gapOut > 0.01 && gapSrc > 0.01) ? gapSrc / gapOut : (gapSrc > 0.01 ? Infinity : 1) });
    }
    /* a moment plays its footage at ITS rate (1 = real time) — len of video in len/rate of audio */
    spans.push({ kind: 'real', srcFrom: m.srcAt, srcTo: m.srcAt + m.len,
                 outFrom: aAt, outTo: aAt + outLen(m), speed: rateOf(m), id: m.id });
    srcCur = m.srcAt + m.len; outCur = aAt + outLen(m);
  }
  if (!impossible) {
    const tailSrc = vidTotal - srcCur, tailOut = audioTotal - outCur;
    if (tailSrc > 0.01 || tailOut > 0.01) {
      /* Same rule at the end as at the start: video with no audio left to play it in
         is left OUT, not treated as a failure. The film ends on the last moment. */
      if (tailSrc > 0.01 && tailOut <= 0.01) {
        spans.push({ kind: 'skip', srcFrom: srcCur, srcTo: vidTotal,
                     outFrom: outCur, outTo: audioTotal, speed: null });
      } else {
        spans.push({ kind: 'filler', srcFrom: srcCur, srcTo: vidTotal, outFrom: outCur, outTo: audioTotal,
                     speed: (tailOut > 0.01 && tailSrc > 0.01) ? tailSrc / tailOut : (tailSrc > 0.01 ? Infinity : 1) });
      }
    }
  }
  const fillerSrc = Math.max(0, vidTotal - realTotal);
  const fillerOut = audioTotal - realTotal;
  const overall = (fillerSrc > 0 && fillerOut > 0) ? fillerSrc / fillerOut : null;
  return {
    videoTotal: +vidTotal.toFixed(2),
    audioTotal: +audioTotal.toFixed(2),
    realTotal: +realTotal.toFixed(2),
    fillerSource: +fillerSrc.toFixed(2),
    fillerOutput: +fillerOut.toFixed(2),
    speed: overall ? +overall.toFixed(3) : null,     // the average, for the header
    /* ⚠️ `isFinite(null)` is TRUE, so a skip span's `speed: null` reached `.toFixed`
       and threw a 500 on every plan read. Test the type, not the finiteness. */
    spans: spans.map(x => ({ ...x,
      speed: (typeof x.speed === 'number' && isFinite(x.speed)) ? +x.speed.toFixed(3) : null })),
    windows: STATE.ramps.length,
    ok: !!audioTotal && fillerOut > 0.05 && !impossible,
    why: !audioTotal ? 'add an audio bed — it sets the target length'
       : impossible ? impossible
       : fillerOut <= 0.05 ? 'your real-time moments already fill (or exceed) the audio'
       : null,
  };
}
/* ---------------- per-source TRIM ----------------
 * Josh, 2026-09-11: "in our assets section if we could just actually shorten the video
 * that's actually included ... not saying we actually have to clip the videos like from
 * a files standpoint, but we should clip them from a what will actually be used and
 * seen in the video standpoint."
 * So the FILE is never touched. Each source carries trimIn/trimOut, and everything
 * downstream asks these two helpers instead of reading s.duration directly — that way
 * a trim shortens the continuous timeline, the plan and the export all at once.
 * useIn/useOut are always a valid range inside the real file. */
/* "Foo.mov" -> "Foo.mov (2)" -> "Foo.mov (3)" — so split halves are tellable apart. */
function nextPartName(name) {
  const m = String(name || 'clip').match(/^(.*?)\s*\((\d+)\)\s*$/);
  const base = m ? m[1] : String(name || 'clip');
  let n = m ? +m[2] + 1 : 2;
  const taken = new Set((STATE.sources || []).map(x => x.name));
  while (taken.has(`${base} (${n})`)) n++;
  return `${base} (${n})`;
}
/* Is this mark inside the part of its clip that's actually used? Mirrors the client's
   rule of the same name — a trim or a split can leave a mark outside its own half. */
function rampInVideo(r) {
  const s = (STATE.sources || []).find(x => x.id === r.sourceId);
  if (!s || s.off) return false;
  return r.start + r.len > useIn(s) - 0.01 && r.start < useOut(s) + 0.01;
}
function useIn(s)  { return Math.max(0, Math.min(+s.trimIn || 0, s.duration || 0)); }
function useOut(s) {
  const d = s.duration || 0;
  const o = (s.trimOut == null || s.trimOut === '') ? d : +s.trimOut;
  return Math.max(useIn(s), Math.min(o, d));
}
/* `off` = ARCHIVED, not deleted. Josh, 2026-09-14: "a way I could just disable using a
   video instead of having to delete it entirely... it just won't be in the export or in
   the output. It can be re-enabled... we don't actually lose the file or the associated
   slowdowns." A disabled clip contributes ZERO length, so it drops out of the continuous
   timeline, the plan and the export at once — while its file and its marks stay put. */
function useLen(s) { return s.off ? 0 : Math.max(0, useOut(s) - useIn(s)); }

// where a source begins on the CONTINUOUS input line (trimmed lengths)
function srcOffset(sourceId) {
  let acc = 0;
  for (const s of STATE.sources) {
    if (s.id === sourceId) return acc;
    acc += useLen(s);
  }
  return NaN;
}

/* ---------------- render ---------------- */
/**
 * Cut each timeline chunk from its PROXY, concat, then lay the audio bed over
 * the top. Chunks are re-encoded (not stream-copied) because a stream copy
 * snaps to keyframes and would silently move his cut points.
 */
/* RAMP render: walk each source start-to-finish. Inside a marked window the video
   plays at 1x; between windows it is sped up by the plan's factor so the whole
   thing lands on the audio. setpts=PTS/N is the speed change. */
async function renderRamp(onProgress) {
  const plan = rampPlan();
  if (!plan.ok) throw new Error(plan.why || 'cannot build a plan yet');
  if (!STATE.sources.length) throw new Error('no input video');
  const work = path.join(OUT, 'ramp-' + id8());
  await fsp.mkdir(work, { recursive: true });
  const parts = [];
  let done = 0;

  /* Walk the PLAN's spans — each has its OWN speed, because each mark is pinned to a
     moment in the audio and the video before it is compressed to arrive there.
     Spans are in CONTINUOUS input coordinates, so split any span that crosses a
     source boundary before cutting. */
  const segs = [];
  for (const sp of plan.spans) {
    /* A `skip` span is video with no audio to play it in — it is deliberately left
       OUT of the film (see rampPlan). Render nothing for it. */
    if (sp.kind === 'skip') continue;
    if (sp.srcTo - sp.srcFrom <= 0.02) continue;
    let a = sp.srcFrom;
    let acc = 0;
    for (const src of STATE.sources) {
      const d = useLen(src);                 // only the kept part occupies the timeline
      const s0 = acc, s1 = acc + d;
      acc = s1;
      if (sp.srcTo <= s0 || a >= s1) continue;
      const from = Math.max(a, s0), to = Math.min(sp.srcTo, s1);
      if (to - from <= 0.02) continue;
      // timeline -> position INSIDE the file: shift past whatever was trimmed off the head
      const t0 = useIn(src);
      segs.push({ src, from: from - s0 + t0, to: to - s0 + t0, real: sp.kind === 'real',
                  speed: sp.kind === 'real' ? (sp.speed || 1) : (sp.speed || plan.speed || 1) });
      a = to;
    }
  }
  if (!segs.length) throw new Error('nothing to render');

  for (let i = 0; i < segs.length; i++) {
    const g = segs[i];
    const dur = Math.max(0.04, g.to - g.from);
    const part = path.join(work, `s${String(i).padStart(4, '0')}.mp4`);
    const speed = g.real ? (g.speed || 1) : (g.speed || plan.speed || 1);   // a moment's own rate
    const vf = (Math.abs(speed - 1) < 0.001) ? 'fps=30' : `setpts=PTS/${speed},fps=30`;
    await run('ffmpeg', ['-v', 'error', '-y',
      '-ss', String(g.from), '-t', String(dur),
      '-i', path.join(PROXIES, g.src.proxy),
      '-vf', vf,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-pix_fmt', 'yuv420p', '-an', part]);
    parts.push(part);
    done++;
    if (onProgress) onProgress(Math.round((done / segs.length) * 80));
  }

  const listFile = path.join(work, 'list.txt');
  await fsp.writeFile(listFile, parts.map(x => `file '${x.replace(/'/g, "'\\''")}'`).join('\n'));
  const silent = path.join(work, 'video.mp4');
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', silent]);

  /* Burn the transcript in, if he asked for it. Done on the SILENT video before the
     bed is laid over, so the subtitle filter never has to re-encode the audio. */
  let vidForMux = silent;
  if (STATE.burnSubs && (STATE.transcript || []).length) {
    /* ASS, not SRT: SRT is line-level only and cannot light the word being said.
       Any segment without per-word timings still renders as a plain line. */
    const ass = path.join(work, 'subs.ass');
    /* Size the subtitles to the ACTUAL frame — probing the rendered video rather than
       assuming 1080p, so the margins and font hold whatever he shot. */
    const vinfo = await probe(silent).catch(() => ({}));
    await fsp.writeFile(ass, transcriptToAss({
      width: vinfo.width || 1920, height: vinfo.height || 1080,
      ...(STATE.subStyle || {}) }), 'utf8');
    const subbed = path.join(work, 'subbed.mp4');
    await run('ffmpeg', ['-v', 'error', '-y', '-i', silent,
      '-vf', `ass=${ass.replace(/([:'\\])/g, '\\$1')}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-an', subbed]);
    vidForMux = subbed;
  }
  const finalOut = path.join(OUT, `ramp-${Date.now()}.mp4`);
  if (STATE.audio.length) {
    const aList = path.join(work, 'alist.txt');
    await fsp.writeFile(aList, STATE.audio.map(a =>
      `file '${path.join(AUDIO, a.file).replace(/'/g, "'\\''")}'`).join('\n'));
    const bed = path.join(work, 'bed.m4a');
    await run('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', aList,
      '-c:a', 'aac', '-b:a', '192k', bed]);
    await run('ffmpeg', ['-v', 'error', '-y', '-i', vidForMux, '-i', bed,
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', finalOut]);
  } else {
    await fsp.copyFile(vidForMux, finalOut);
  }
  if (onProgress) onProgress(100);
  await fsp.rm(work, { recursive: true, force: true });
  return path.basename(finalOut);
}

async function renderTimeline(onProgress) {
  const s = STATE;
  if (!s.timeline.length) throw new Error('timeline is empty');
  const work = path.join(OUT, 'work-' + id8());
  await fsp.mkdir(work, { recursive: true });
  const parts = [];
  /* Each chunk plays at its own spot in the audio. The lead-in before the first chunk
     holds its first frame; a gap after a chunk holds its last frame (tpad clone) —
     so the picture never jumps ahead of where he placed it. */
  const places = chunkPlaces(s.timeline).filter(p => p.len > 0.01);
  for (let k = 0; k < places.length; k++) {
    const { c, at, len } = places[k];
    const src = s.sources.find(x => x.id === c.sourceId);
    if (!src) throw new Error('a clip points at a source that is gone');
    const part = path.join(work, `p${String(k).padStart(4, '0')}.mp4`);
    const lead = k === 0 ? at : 0;
    const next = places[k + 1];
    const gap = next ? Math.max(0, next.at - (at + len)) : 0;
    const pads = [];
    if (lead > 0.01) pads.push(`start_mode=clone:start_duration=${lead.toFixed(3)}`);
    if (gap > 0.01) pads.push(`stop_mode=clone:stop_duration=${gap.toFixed(3)}`);
    /* `len` here is OUTPUT seconds; at this chunk's rate that is len*rate of footage */
    const rate = rateOf(c);
    const vf = [];
    if (Math.abs(rate - 1) > 0.001) vf.push(`setpts=PTS/${rate}`, 'fps=30');
    if (pads.length) vf.push(`tpad=${pads.join(':')}`);
    await run('ffmpeg', ['-v', 'error', '-y',
      '-ss', String(c.start), '-t', String(+(len * rate).toFixed(3)),
      '-i', path.join(PROXIES, src.proxy),
      ...(vf.length ? ['-vf', vf.join(',')] : []),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-pix_fmt', 'yuv420p', '-an', part]);
    parts.push(part);
    if (onProgress) onProgress(Math.round(((k + 1) / places.length) * 80));
  }
  const listFile = path.join(work, 'list.txt');
  await fsp.writeFile(listFile, parts.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
  const silent = path.join(work, 'video.mp4');
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', silent]);

  const finalOut = path.join(OUT, `cut-${Date.now()}.mp4`);
  if (s.audio.length) {
    const aList = path.join(work, 'alist.txt');
    await fsp.writeFile(aList, s.audio.map(a =>
      `file '${path.join(AUDIO, a.file).replace(/'/g, "'\\''")}'`).join('\n'));
    const bed = path.join(work, 'bed.m4a');
    await run('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', aList,
      '-c:a', 'aac', '-b:a', '192k', bed]);
    await run('ffmpeg', ['-v', 'error', '-y', '-i', silent, '-i', bed,
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', finalOut]);
  } else {
    await fsp.copyFile(silent, finalOut);
  }
  if (onProgress) onProgress(100);
  await fsp.rm(work, { recursive: true, force: true });
  return path.basename(finalOut);
}

/* ---------------- render one or MANY chapters ----------------
 * Josh, 2026-09-15: "if I have a chapter open and it has two chapters it should always
 * ... allow me to export those as one long movie as one long MP4 — that was the whole
 * point of what I was saying earlier, to give it a menu that actually lets me choose
 * what I'm exporting."
 *
 * Each chapter is its own little film (its own clips, its own audio bed, its own mode),
 * so "one long MP4" means: render each chapter exactly as it renders on its own, then
 * concatenate the results in chapter order.
 *
 * ⚠️ HOW IT PICKS UP EACH CHAPTER, and why it is done this way: renderRamp/renderTimeline
 * read the ACTIVE chapter out of STATE — that is the whole point of the chapters design.
 * So instead of teaching them a second way to find their input (which is precisely how a
 * fix reaches only half the call sites), this makes each chapter briefly active through
 * the SAME switchChapter() the UI uses, renders, and switches back. One code path.
 *
 * ⚠️ THE ACTIVE CHAPTER MUST BE RESTORED NO MATTER WHAT. If a render throws halfway, he
 * must not be left sitting in a different chapter than the one he was editing — so the
 * restore is in a `finally`, and it saves afterwards.
 */
async function renderChapters(ids, onProgress) {
  const startedIn = STATE.chapterId;
  const known = new Set(chapterList().map(c => c.id));
  /* Export in CHAPTER ORDER (the strip's order), not the order the ids arrived in —
     "one long movie" means the film runs intro-first regardless of tick order. */
  const order = chapterList().map(c => c.id).filter(id => ids.includes(id) && known.has(id));
  if (!order.length) throw new Error('no chapters selected to export');

  // ONE chapter: render it exactly as before. No concat step, no re-encode.
  if (order.length === 1) {
    try {
      if (order[0] !== startedIn && !switchChapter(order[0])) throw new Error('no such chapter');
      const doRender = STATE.mode === 'ramp' ? renderRamp : renderTimeline;
      return await doRender(onProgress);
    } finally {
      if (STATE.chapterId !== startedIn) { switchChapter(startedIn); }
      saveState(STATE);
    }
  }

  const work = path.join(OUT, 'multi-' + id8());
  await fsp.mkdir(work, { recursive: true });
  const parts = [];
  try {
    for (let i = 0; i < order.length; i++) {
      if (!switchChapter(order[i])) throw new Error('no such chapter');
      const title = STATE.chapterTitle;
      const doRender = STATE.mode === 'ramp' ? renderRamp : renderTimeline;
      /* Each chapter gets its own slice of the progress bar, so the number keeps
         climbing across the whole job instead of restarting per chapter. */
      const lo = Math.round((i / order.length) * 96);
      const hi = Math.round(((i + 1) / order.length) * 96);
      let made;
      try {
        made = await doRender(p => onProgress && onProgress(lo + Math.round((p / 100) * (hi - lo))));
      } catch (e) {
        /* Name the chapter that failed — "timeline is empty" is useless when it could
           have come from any of them. */
        throw new Error(`“${title}”: ${e.message}`);
      }
      parts.push(path.join(OUT, made));
    }

    /* Stitch. The per-chapter films already share a codec, pixel format and frame rate
       (every render ends in the same libx264/yuv420p/30fps mux), so they concatenate
       without a re-encode — except the AUDIO, which has to be re-encoded because each
       chapter's bed was muxed separately and a stream copy would carry the first
       chapter's timestamps across the joins. */
    const listFile = path.join(work, 'list.txt');
    await fsp.writeFile(listFile, parts.map(x => `file '${x.replace(/'/g, "'\\''")}'`).join('\n'));
    const finalOut = path.join(OUT, `chapters-${Date.now()}.mp4`);
    await run('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', finalOut]);
    if (onProgress) onProgress(100);
    return path.basename(finalOut);
  } finally {
    /* back to where he was, whatever happened above */
    if (STATE.chapterId !== startedIn) switchChapter(startedIn);
    saveState(STATE);
    await fsp.rm(work, { recursive: true, force: true });
  }
}

/* ---------------- routes ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    /* THE APP'S OWN CODE IS NEVER CACHED. With no cache headers the browser applies its
       own heuristic and happily serves a stale app.js — which is how a reload came back
       running the PREVIOUS build, looking exactly like the new code was broken. The media
       files below still cache normally; this is only the two files that ARE the app. */
    // each screen has its own address (Josh, 2026-09-26: "if I reload the assets page, it
    // goes back to the home page every time") — same app, the page reads the path
    if (p === '/' || p === '/index.html' || p === '/input' || p === '/output' || p === '/assets') {
      res.setHeader('Cache-Control', 'no-store, must-revalidate');
      return serveFile(req, res, path.join(ROOT, 'public', 'index.html'), MIME['.html']);
    }
    if (p === '/app.js') {
      res.setHeader('Cache-Control', 'no-store, must-revalidate');
      return serveFile(req, res, path.join(ROOT, 'public', 'app.js'), MIME['.js']);
    }
    if (p === '/api/state') return sendJSON(res, { ...STATE, jobs: Object.fromEntries(jobs) });

    if (p === '/api/grab-len' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      if (b.len != null) STATE.grabLen = Number(b.len) || 1;
      if (b.rate != null && cleanRate(b.rate)) STATE.grabRate = cleanRate(b.rate);
      saveState(STATE);
      return sendJSON(res, { ok: true, grabLen: STATE.grabLen, grabRate: STATE.grabRate || 1 });
    }

    // upload a source video -> proxy in background
    if (p === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': hello\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    // cheap "did the clip list change?" — the page polls this so Inbox imports just appear
    if (p === '/api/sources-sig' && req.method === 'GET') {
      return sendJSON(res, { sig: STATE.sources.map(x => `${x.id}:${x.ready ? 1 : 0}${x.failed ? 'f' : ''}`).join(','),
                             inbox: INBOX });
    }
    if (p === '/api/upload-source' && req.method === 'POST') {
      const name = safe(url.searchParams.get('name'));
      const buf = await readBody(req);
      const id = id8();
      const ext = path.extname(name) || '.mov';
      const srcFile = `${id}${ext}`;
      await fsp.writeFile(path.join(SOURCES, srcFile), buf);
      /* ?at=N inserts at that position instead of appending. Josh, 2026-09-23: "it
         automatically gets appended to the bottom and then I have to kind of click all
         the way up... I should be able to upload a video in between these videos." */
      const atRaw = url.searchParams.get('at');
      const at = atRaw === null || atRaw === '' ? NaN : Number(atRaw);
      const r = await addSourceFile(id, srcFile, name, buf.length, at);
      if (r.error) return sendJSON(res, r, 400);
      return sendJSON(res, { ok: true, source: r.entry });
    }

    if (p === '/api/upload-audio' && req.method === 'POST') {
      const name = safe(url.searchParams.get('name'));
      const buf = await readBody(req);
      const id = id8();
      const ext = path.extname(name) || '.m4a';
      const file = `${id}${ext}`;
      await fsp.writeFile(path.join(AUDIO, file), buf);
      const info = await probe(path.join(AUDIO, file));
      if (!info.hasAudio) {
        await fsp.unlink(path.join(AUDIO, file)).catch(() => {});
        return sendJSON(res, { error: 'that file has no audio track' }, 400);
      }
      const entry = { id, name, file, duration: info.duration };
      STATE.audio.push(entry);
      saveState(STATE);
      return sendJSON(res, { ok: true, audio: entry });
    }

    if (p.startsWith('/media/proxy/')) {
      const f = path.basename(p.slice('/media/proxy/'.length));
      return serveFile(req, res, path.join(PROXIES, f), MIME['.mp4']);
    }
    if (p.startsWith('/media/audio/')) {
      const f = path.basename(p.slice('/media/audio/'.length));
      return serveFile(req, res, path.join(AUDIO, f), MIME[path.extname(f)] || 'audio/mpeg');
    }
    if (p.startsWith('/media/out/')) {
      const f = path.basename(p.slice('/media/out/'.length));
      return serveFile(req, res, path.join(OUT, f), MIME['.mp4']);
    }

    if (p === '/api/grab' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const src = STATE.sources.find(x => x.id === b.sourceId);
      if (!src) return sendJSON(res, { error: 'unknown source' }, 400);
      const len = Number(b.len) || STATE.grabLen;
      let start = Math.max(0, Number(b.start) || 0);
      if (start + len > src.duration) start = Math.max(0, src.duration - len);
      // where it lands in the audio: what he set, else right after the last chunk
      const places = chunkPlaces(STATE.timeline);
      const lastEnd = places.length ? places[places.length - 1].at + places[places.length - 1].len : 0;
      let audioAt = Number(b.audioAt);
      if (!isFinite(audioAt)) audioAt = lastEnd;
      const rate = cleanRate(b.rate) || 1;
      const bt = bedTotal();
      audioAt = Math.max(0, bt ? Math.min(Math.max(0, bt - len / rate), audioAt) : audioAt);
      const clip = { id: id8(), sourceId: src.id, sourceName: src.name,
                     start: +start.toFixed(3), len: +len.toFixed(3), rate, audioAt: +audioAt.toFixed(3) };
      STATE.timeline.push(clip);
      sortTimeline();
      saveState(STATE);
      return sendJSON(res, { ok: true, clip, timeline: STATE.timeline });
    }

    if (p === '/api/clip' && req.method === 'DELETE') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      STATE.timeline = STATE.timeline.filter(c => c.id !== b.id);
      saveState(STATE);
      return sendJSON(res, { ok: true, timeline: STATE.timeline });
    }
    if (p === '/api/clip/move' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const i = STATE.timeline.findIndex(c => c.id === b.id);
      if (i < 0) return sendJSON(res, { error: 'no such clip' }, 400);
      const [c] = STATE.timeline.splice(i, 1);
      STATE.timeline.splice(Math.max(0, Math.min(STATE.timeline.length, b.to)), 0, c);
      saveState(STATE);
      return sendJSON(res, { ok: true, timeline: STATE.timeline });
    }
    /* Edit a clip that is already on the timeline. Chunks stay "live" — start
       and length are just numbers until export, so re-editing costs nothing. */
    if (p === '/api/clip/edit' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const c = STATE.timeline.find(x => x.id === b.id);
      if (!c) return sendJSON(res, { error: 'no such clip' }, 400);
      const src = STATE.sources.find(x => x.id === c.sourceId);
      const dur = src?.duration || 1e9;
      if (b.len != null) c.len = Math.max(0.1, Math.min(dur, Number(b.len)));
      if (b.start != null) c.start = Number(b.start);
      c.start = Math.max(0, Math.min(dur - c.len, c.start));
      c.start = +c.start.toFixed(3);
      c.len = +c.len.toFixed(3);
      if (b.rate != null && cleanRate(b.rate)) c.rate = cleanRate(b.rate);
      if (b.audioAt != null && isFinite(Number(b.audioAt))) c.audioAt = Number(b.audioAt);
      { const bt = bedTotal();   // the whole chunk stays inside the audio, like a moment
        c.audioAt = +Math.max(0, bt ? Math.min(Math.max(0, bt - outLen(c)), c.audioAt || 0) : (c.audioAt || 0)).toFixed(3); }
      sortTimeline();
      saveState(STATE);
      return sendJSON(res, { ok: true, clip: c, timeline: STATE.timeline });
    }

    if (p === '/api/clip/nudge' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const c = STATE.timeline.find(x => x.id === b.id);
      if (!c) return sendJSON(res, { error: 'no such clip' }, 400);
      const src = STATE.sources.find(x => x.id === c.sourceId);
      c.start = Math.max(0, Math.min((src?.duration || 1e9) - c.len, c.start + Number(b.delta || 0)));
      c.start = +c.start.toFixed(3);
      saveState(STATE);
      return sendJSON(res, { ok: true, timeline: STATE.timeline });
    }
    /* 🔇 SILENCE BEFORE / AFTER A BED. Josh, 2026-09-22: "right now I have no
       opportunity to put pauses in the audio between chapters... it would have like a
       brief pause before I launch into the audio. So if I could add like a buffer to
       the audio on the assets page... how much buffer I want either before or after."
       Done PHYSICALLY — a padded copy of the file — so every consumer (playback,
       audioTotal, the plan, transcription, render) sees one ordinary longer bed and
       none of them needs to know padding exists. That is the "centralize it" he asked
       for an hour earlier, applied up front: no new rule for five places to agree on.
       The ORIGINAL is never touched (`src`), and every re-pad is made from it, so
       changing your mind is lossless. Moments and captions are pinned to AUDIO time,
       so they are shifted by exactly the silence added in front of them — otherwise a
       1s pad would slide every mark and caption 1s off the words it was set on. */
    if (p === '/api/audio/pad' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const a = STATE.audio.find(x => x.id === b.id);
      if (!a) return sendJSON(res, { error: 'no such audio' }, 400);
      const clamp = v => Math.max(0, Math.min(10, Math.round((Number(v) || 0) * 100) / 100));
      try { await relayoutBed(a, { before: clamp(b.before), after: clamp(b.after), gaps: a.gaps || [] }); }
      catch (e) { return sendJSON(res, { error: String(e.message || e) }, 500); }
      return sendJSON(res, { ok: true, audio: STATE.audio, plan: rampPlan() });
    }
    /* 🔇 SILENCE ANYWHERE IN A BED. Josh, 2026-09-25: "a bit of silence in my audio bed...
       at another time so that I can show the screen... inject a bit of silence in there
       that is respected in the main view, the edited view, the outputted view, and then
       the exported." Same physical approach as the pad above (the same relayoutBed), so
       all four surfaces get it with nothing new to agree on.
       POST {at, dur}            → insert `dur` seconds at chapter-audio time `at`
       POST {audioId, gapId, dur} → change one silence's length
       POST {audioId, gapId, moveTo[, dur]} → move one silence so it STARTS at chapter-audio
                                   time `moveTo` (Josh, 2026-09-26: "click on it like I can the
                                   other bits and then edit where it's at how long it is")
       DELETE {audioId, gapId}   → remove one silence */
    if (p === '/api/audio/silence' && (req.method === 'POST' || req.method === 'DELETE')) {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const clampD = v => Math.max(0.05, Math.min(60, Math.round((Number(v) || 0) * 100) / 100));
      let a, gaps;
      if (b.gapId) {
        a = STATE.audio.find(x => x.id === b.audioId);
        if (!a) return sendJSON(res, { error: 'no such audio' }, 400);
        if (req.method === 'POST' && b.moveTo != null && isFinite(Number(b.moveTo))) {
          /* MOVE = take it out, then put it back so it starts exactly at `moveTo` as he'll SEE
             it afterwards — i.e. `moveTo` is read on the line WITHOUT this silence, so "+1"
             moves it one second later rather than by (1 − its own length). */
          const cur = bedGaps(a).find(g => g.id === b.gapId);
          if (!cur) return sendJSON(res, { error: 'no such silence' }, 400);
          const dur = b.dur != null ? clampD(b.dur) : cur.dur;
          const opts = { before: a.padBefore || 0, after: a.padAfter || 0, gaps: (a.gaps || []).map(g => ({ ...g })) };
          if (cur.id === 'before') opts.before = 0; else if (cur.id === 'after') opts.after = 0;
          else opts.gaps = opts.gaps.filter(x => x.id !== cur.id);
          let base = 0; for (const x of STATE.audio) { if (x === a) break; base += x.duration || 0; }
          const without = bedGaps({ ...a, padBefore: opts.before, padAfter: opts.after, gaps: opts.gaps });
          const withoutLen = (a.duration || 0) - cur.dur;
          const local = Math.max(0, Math.min(withoutLen, Number(b.moveTo) - base));
          const orig = +bedInverse(without, local).orig.toFixed(3);
          const srcDur = a.srcDuration ?? a.duration ?? 0;
          let id = cur.id;
          if (cur.id === 'before' && orig <= 0.001) opts.before = Math.min(10, dur);           // stayed at the very start
          else if (cur.id === 'after' && orig >= srcDur - 0.001) opts.after = Math.min(10, dur); // stayed at the very end
          else { if (id === 'before' || id === 'after') id = id8(); opts.gaps.push({ id, at: orig, dur }); }
          try { await relayoutBed(a, opts); } catch (e) { return sendJSON(res, { error: String(e.message || e) }, 500); }
          return sendJSON(res, { ok: true, silence: { audioId: a.id, id }, audio: STATE.audio, plan: rampPlan() });
        }
        if (b.gapId === 'before' || b.gapId === 'after') {
          const key = b.gapId === 'before' ? 'before' : 'after';
          const opts = { before: a.padBefore || 0, after: a.padAfter || 0, gaps: a.gaps || [] };
          opts[key] = req.method === 'DELETE' ? 0 : Math.min(10, clampD(b.dur));
          try { await relayoutBed(a, opts); } catch (e) { return sendJSON(res, { error: String(e.message || e) }, 500); }
          return sendJSON(res, { ok: true, audio: STATE.audio, plan: rampPlan() });
        }
        gaps = (a.gaps || []).map(g => ({ ...g }));
        const g = gaps.find(x => x.id === b.gapId);
        if (!g) return sendJSON(res, { error: 'no such silence' }, 400);
        if (req.method === 'DELETE') gaps = gaps.filter(x => x.id !== b.gapId);
        else g.dur = clampD(b.dur);
      } else {
        // find the bed holding chapter-audio time `at`, and where that is in its ORIGINAL audio
        const at = Math.max(0, Number(b.at) || 0);
        let base = 0;
        for (const x of STATE.audio) { if (at < base + (x.duration || 0) - 1e-6) { a = x; break; } base += x.duration || 0; }
        if (!a) a = STATE.audio[STATE.audio.length - 1];
        if (!a) return sendJSON(res, { error: 'add an audio bed first' }, 400);
        base = 0; for (const x of STATE.audio) { if (x === a) break; base += x.duration || 0; }
        const hit = bedInverse(bedGaps(a), at - base);
        gaps = (a.gaps || []).map(g => ({ ...g }));
        const dur = clampD(b.dur || 2);
        if (hit.gap) {                       // clicked inside an existing silence: make it longer
          if (hit.gap === 'before' || hit.gap === 'after') {
            const opts = { before: a.padBefore || 0, after: a.padAfter || 0, gaps };
            opts[hit.gap] = Math.min(10, (opts[hit.gap] || 0) + dur);
            try { await relayoutBed(a, opts); } catch (e) { return sendJSON(res, { error: String(e.message || e) }, 500); }
            return sendJSON(res, { ok: true, audio: STATE.audio, plan: rampPlan() });
          }
          const g = gaps.find(x => x.id === hit.gap); g.dur = +(g.dur + dur).toFixed(2);
        } else {
          gaps.push({ id: id8(), at: +hit.orig.toFixed(3), dur });
        }
      }
      try { await relayoutBed(a, { before: a.padBefore || 0, after: a.padAfter || 0, gaps }); }
      catch (e) { return sendJSON(res, { error: String(e.message || e) }, 500); }
      return sendJSON(res, { ok: true, audio: STATE.audio, plan: rampPlan() });
    }
    /* ✎ RENAME a clip or an audio bed. Josh, 2026-09-22: "allow me to edit the file
       names of the movies themselves in this interface... I can just drag it in there
       and then rename the actual file itself afterwards... renames a file in place if
       that's how it's working under the hood."
       Under the hood Magpie never touches his original: an upload is COPIED to an
       id-named file (media/sources/<id>.mov), and `name` is only its label. So the
       honest "rename in place" is the label — and the label is COPIED into other
       records (each chunk's and moment's `sourceName`, and parked chapters that hold
       the same clip). All of them are updated here, or a renamed clip would still show
       its old name on its chunks. */
    if (p === '/api/rename' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const name = String(b.name || '').replace(/[\/\\\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
      if (!name) return sendJSON(res, { error: 'a name can\'t be empty' }, 400);
      const books = [STATE, ...(STATE.chapters || [])];     // the live chapter + parked ones
      let hit = 0;
      for (const bk of books) {
        if (b.kind === 'audio') {
          for (const a of (bk.audio || [])) if (a.id === b.id) { a.name = name; hit++; }
        } else {
          for (const s of (bk.sources || [])) if (s.id === b.id) { s.name = name; hit++; }
          for (const c of (bk.timeline || [])) if (c.sourceId === b.id) c.sourceName = name;
          for (const r of (bk.ramps || []))    if (r.sourceId === b.id) r.sourceName = name;
        }
      }
      if (!hit) return sendJSON(res, { error: 'nothing by that id' }, 400);
      saveState(STATE);
      return sendJSON(res, { ok: true, name });
    }
    if (p === '/api/audio' && req.method === 'DELETE') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      STATE.audio = STATE.audio.filter(a => a.id !== b.id);
      saveState(STATE);
      return sendJSON(res, { ok: true, audio: STATE.audio });
    }
    /* Removing a source takes its work with it. ⚠️ This used to clean `timeline` but
       NOT `ramps`, leaving speed-mode moments pointing at a source that no longer
       exists — they survived in the data, were still counted in `windows`, and were
       silently dropped by the plan's isFinite filter.
       Josh, 2026-09-10: "if I remove one, it should warn me like hey, you already have
       a real time bit associated to this. Do you actually want to delete this and the
       associated real time?" — so: GET the impact first, DELETE with confirm. */
    if (p === '/api/source' && req.method === 'DELETE') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const ramps = STATE.ramps.filter(r => r.sourceId === b.id);
      const clips = STATE.timeline.filter(c => c.sourceId === b.id);
      if ((ramps.length || clips.length) && !b.confirm) {
        return sendJSON(res, { ok: false, needsConfirm: true,
          ramps: ramps.length, clips: clips.length }, 409);
      }
      STATE.sources = STATE.sources.filter(s => s.id !== b.id);
      STATE.timeline = STATE.timeline.filter(c => c.sourceId !== b.id);
      STATE.ramps = STATE.ramps.filter(r => r.sourceId !== b.id);   // ⚠️ was missing
      saveState(STATE);
      return sendJSON(res, { ok: true, removedRamps: ramps.length, removedClips: clips.length });
    }

    /* ↪ MOVE A CLIP TO ANOTHER CHAPTER. Josh, 2026-09-26: "I split a clip and I wanted to use
       the second half... in a different video... give me the chance to move a clip into a
       different chapter altogether." The clip's file is untouched; its entry moves, and its
       moments and chunks go WITH it (nothing is deleted — they keep their audio times, so
       they may need nudging against the new chapter's audio). {id, to, from?, at?} */
    if (p === '/api/source/to-chapter' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const book = cid => (!cid || cid === STATE.chapterId) ? STATE : (STATE.chapters || []).find(c => c.id === cid);
      const from = book(b.from), to = book(b.to);
      if (!from || !to) return sendJSON(res, { error: 'no such chapter' }, 404);
      if (from === to) return sendJSON(res, { error: 'it is already in that chapter' }, 400);
      const i = (from.sources || []).findIndex(x => x.id === b.id);
      if (i < 0) return sendJSON(res, { error: 'no such clip' }, 400);
      const [src] = from.sources.splice(i, 1);
      const ramps = (from.ramps || []).filter(r => r.sourceId === src.id);
      const clips = (from.timeline || []).filter(c => c.sourceId === src.id);
      from.ramps = (from.ramps || []).filter(r => r.sourceId !== src.id);
      from.timeline = (from.timeline || []).filter(c => c.sourceId !== src.id);
      to.sources = to.sources || []; to.ramps = to.ramps || []; to.timeline = to.timeline || [];
      const at = Number(b.at);
      if (Number.isInteger(at) && at >= 0 && at <= to.sources.length) to.sources.splice(at, 0, src);
      else to.sources.push(src);
      to.ramps.push(...ramps); to.timeline.push(...clips);
      saveState(STATE);
      const title = x => x === STATE ? STATE.chapterTitle : x.title;
      return sendJSON(res, { ok: true, name: src.name, fromIndex: i, fromTitle: title(from), toTitle: title(to),
                             moments: ramps.length, chunks: clips.length });
    }
    /* Reorder the input. The sources array IS the running order, so moving one
       re-times everything after it — marks ride along because they store
       (sourceId, offset-within-that-source), never an absolute position. */
    if (p === '/api/source/move' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const from = STATE.sources.findIndex(s => s.id === b.id);
      if (from < 0) return sendJSON(res, { error: 'no such source' }, 400);
      const to = Math.max(0, Math.min(STATE.sources.length - 1, Number(b.to)));
      const [moved] = STATE.sources.splice(from, 1);
      STATE.sources.splice(to, 0, moved);
      saveState(STATE);
      return sendJSON(res, { ok: true, sources: STATE.sources.map(s => s.id) });
    }

    /* Shorten what a clip CONTRIBUTES, without touching the file on disk.
       Josh, 2026-09-11: "not saying we actually have to clip the videos like from a
       files standpoint, but we should clip them from a what will actually be used and
       seen in the video standpoint." Send null for either end to clear it. */
    /* Archive / un-archive a clip. The file and its marks are untouched. */
    if (p === '/api/source/off' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const s = STATE.sources.find(x => x.id === b.id);
      if (!s) return sendJSON(res, { error: 'no such source' }, 400);
      s.off = !!b.off;
      saveState(STATE);
      const kept = STATE.ramps.filter(r => r.sourceId === s.id).length;
      return sendJSON(res, { ok: true, source: s, keptMoments: kept, plan: rampPlan() });
    }

    if (p === '/api/source/trim' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const s = STATE.sources.find(x => x.id === b.id);
      if (!s) return sendJSON(res, { error: 'no such source' }, 400);
      const d = s.duration || 0;
      if ('trimIn' in b)  s.trimIn  = b.trimIn  == null ? 0 : +Math.max(0, Math.min(d, +b.trimIn  || 0)).toFixed(3);
      if ('trimOut' in b) s.trimOut = b.trimOut == null ? null : +Math.max(0, Math.min(d, +b.trimOut || 0)).toFixed(3);
      // keep them the right way round, and never let a clip collapse to nothing
      if (s.trimOut != null && s.trimOut - (s.trimIn || 0) < 0.2) {
        s.trimOut = Math.min(d, (s.trimIn || 0) + 0.2);
      }
      saveState(STATE);
      // a trim can cut past a marked moment — say so instead of silently dropping it
      const orphaned = STATE.ramps.filter(r => r.sourceId === s.id
        && !(r.start + r.len > useIn(s) - 0.01 && r.start < useOut(s) + 0.01)).length;
      return sendJSON(res, { ok: true, source: s, orphaned, plan: rampPlan() });
    }

    /* Split one clip in two at a point inside it.
       Josh, 2026-09-21: "what if I'd like to actually start breaking out chunks of the
       video into their own... completely split the video".
       Nothing is re-encoded and no new file is written — the halves are two entries
       pointing at the SAME media with complementary trims, exactly like a trim. The
       marks he already placed stay with whichever half actually contains them. */
    if (p === '/api/source/split' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const s0 = STATE.sources.find(x => x.id === b.id);
      if (!s0) return sendJSON(res, { error: 'no such clip' }, 400);
      const at = +b.at;
      const lo = useIn(s0), hi = useOut(s0);
      if (!isFinite(at) || at <= lo + 0.2 || at >= hi - 0.2) {
        return sendJSON(res, { error: 'pick a point inside the clip, at least 0.2s from each end' }, 400);
      }
      /* 🚨 A SPLIT CUTS REAL MEDIA. Two entries pointing at one file was the clever
         answer and the WRONG one. Josh, 2026-09-22, after I defended it twice:
           "we're essentially not in any way trimming these things, but somehow fake
            trimming these... why wouldn't that just be the whole length of what I'm
            seeing? ... This is just like an extremely disappointing way. And you keep
            on pushing back like this is the right way. It's not"
         He is right. A piece he can see on the timeline must BE a piece: its own file,
         its own length, its own size. Nothing downstream — export, reorder, a future
         feature — should have to remember an offset to do the obvious thing.
         So: cut the source losslessly (stream copy, no re-encode, no quality loss),
         write two real files, and build a proxy for each. The original is KEPT on disk
         untouched (media/sources) so nothing is destroyed by a cut. */
      /* ⭐ CUT THE PROXY, NOT THE CAMERA FILE — and that is not a compromise here:
         renderRamp/renderTimeline BOTH build the finished film from `PROXIES` (see the
         '-i', path.join(PROXIES, …) lines in each), so the proxy already IS the master
         as far as anything Josh exports is concerned. Cutting it costs him nothing he
         wasn't already spending, and it is the difference between instant and ~10
         minutes: his camera files are 2822x1628@60 (measured: 48s of CPU to re-encode
         60s), while the proxy is 30fps with `-g 15` — a keyframe every half second —
         so a stream copy lands within ~0.5s of the point he picked, with no re-encode.
         The original recording is left WHOLE in media/sources, so nothing he shot is
         ever destroyed by a cut and a bad split is always recoverable. */
      const idx = STATE.sources.indexOf(s0);
      if (!s0.ready || !s0.proxy) {
        return sendJSON(res, { error: 'that clip is still preparing — try again in a moment' }, 409);
      }
      const proxyPath = path.join(PROXIES, s0.proxy);
      const headId = id8(), tailId = id8();
      const headProxy = `${headId}.mp4`, tailProxy = `${tailId}.mp4`;

      /* -ss/-to AFTER -i is the ACCURATE seek. (-ss before -i is the fast one and it
         snaps to a keyframe — measured on a real cut: both halves started at the same
         pts and their durations OVERLAPPED. Do not "optimise" this back.) */
      /* `toEnd` = this piece runs to the end of the file. Passing `-to` there costs a
         GOP (it truncates to the last keyframe BEFORE the end, losing ~0.5s of real
         footage with nothing after it to recover from); omitting it keeps every
         remaining frame. Measured: tail 21.800 with `-to`, 22.300 without. */
      /* ⚠️ `-ss 0` is NOT a no-op — it DROPS THE FIRST GOP. Verified: the same cut with
         `-ss 0` produced a head whose frame at 10s equalled the source at 10.4995s
         (half a second of footage silently gone from the front), while omitting `-ss`
         matched the source exactly. So pass `-ss` only when actually seeking. */
      const rawCut = async (outFile, from, to, toEnd) => {
        await run('ffmpeg', ['-v', 'error', '-y', '-i', proxyPath,
                             ...(from > 0.01 ? ['-ss', String(from)] : []),
                             ...(toEnd ? [] : ['-to', String(to)]),
                             '-c', 'copy', '-avoid_negative_ts', 'make_zero',
                             '-movflags', '+faststart', path.join(PROXIES, outFile)]);
        return probe(path.join(PROXIES, outFile));
      };
      /* `-c copy` can only end on a GOP boundary, so `-to` truncates to the keyframe at
         or before the target — measured as a CONSISTENT 0.433s short on this encoder
         (asked 5/12.5/20/31.7, every one short by exactly 0.433). Consistent means
         correctable: cut once, MEASURE what we actually got, and re-cut asking for the
         shortfall back. Derived per-file rather than hardcoded, because that constant
         belongs to this proxy's GOP and start-pts, not to every file forever.
         One retry only — this converges immediately or it is not going to. */
      /* `-c copy` can only cut on GOP boundaries, and it rounds the WRONG WAY at BOTH
         ends: `-to` truncates back to the previous keyframe, and `-ss` skips forward to
         the next one. Measured on a real proxy (g=15 @30fps): a head asked for 20.000
         came back 19.567, and a tail asked to start at 20.000 came back 21.800 instead
         of 22.300 — so 0.5s of real footage fell into the gap BETWEEN the two pieces.
         Both errors are consistent, so both are correctable the same way: cut once,
         MEASURE what we actually got, and re-ask adjusted by the shortfall. Derived per
         file — that 0.433/0.5 belongs to this encoder's GOP, not to every file forever.
         One retry, kept only if it genuinely landed closer; otherwise we keep the first
         cut rather than risk making it worse. */
      /* 🚨 DURATION IS NOT CORRECTNESS. An earlier version "fixed" a short head by
         asking for `-to (to + short)`, which produced a head of exactly the right
         LENGTH whose content started half a second late and overlapped the tail —
         verified by hashing decoded frames: head@19.5 was byte-identical to tail@0.
         A piece is right when its CONTENT sits where it should, so cut the START
         accurately (that is the end a viewer notices) and let the END fall on its
         natural GOP boundary.
         `-ss` skips FORWARD to the next keyframe, so to begin at `from` we ask to begin
         slightly earlier and let it snap onto the point we actually want — measured per
         file, because the size of that snap belongs to this proxy's GOP. */
      const cutOne = async (outFile, from, to, toEnd) => {
        let info = await rawCut(outFile, from, to, toEnd);
        if (from <= 0.01) return info;        // starts at 0 — nothing to snap forward
        const want = toEnd ? Math.max(0, (s0.duration || 0) - from) : to - from;
        const short = want - (info.duration || 0);
        if (short > 0.02 && short < 1.5) {
          const retry = await rawCut(outFile, Math.max(0, from - short), to, toEnd);
          const better = retry.duration &&
            Math.abs(retry.duration - want) < Math.abs((info.duration || 0) - want);
          /* The LAST rawCut is what sits on disk, so re-cut the original bounds when
             the retry did not actually help. */
          info = better ? retry : await rawCut(outFile, from, to, toEnd);
        }
        return info;
      };

      const cleanup = async () => {
        await fsp.unlink(path.join(PROXIES, headProxy)).catch(() => {});
        await fsp.unlink(path.join(PROXIES, tailProxy)).catch(() => {});
      };

      let headInfo, tailInfo;
      try {
        const tailRunsToEnd = hi >= (s0.duration || 0) - 0.05;
        headInfo = await cutOne(headProxy, lo, at, false);
        tailInfo = await cutOne(tailProxy, at, hi, tailRunsToEnd);
      } catch (e) {
        await cleanup();
        return sendJSON(res, { error: `could not cut that clip: ${tidyErr(e)}` }, 500);
      }
      /* A cut that produced an unreadable or empty piece must change NOTHING. */
      if (!headInfo.duration || !tailInfo.duration ||
          headInfo.duration < 0.1 || tailInfo.duration < 0.1) {
        await cleanup();
        return sendJSON(res, { error: 'the cut produced an empty piece — nothing changed' }, 500);
      }

      const headBytes = (await fsp.stat(path.join(PROXIES, headProxy))).size;
      const tailBytes = (await fsp.stat(path.join(PROXIES, tailProxy))).size;

      /* Each half is a FULL clip: its own playable file, its own length, its own size,
         and NO trim for anything downstream to remember. `file` keeps pointing at the
         untouched original purely as provenance — nothing reads it for playback or
         export, both of which use `proxy`. */
      const mkHalf = (id, proxyFile, name, info, bytes) => ({
        ...s0, id, name,
        proxy: proxyFile,
        duration: info.duration, width: info.width, height: info.height,
        fps: info.fps, bytes,
        trimIn: null, trimOut: null, ready: true, failed: false,
        splitFrom: s0.splitFrom || s0.file,   // which recording this piece came out of
      });
      const head = mkHalf(headId, headProxy, s0.name, headInfo, headBytes);
      const tail = mkHalf(tailId, tailProxy, nextPartName(s0.name), tailInfo, tailBytes);

      /* Marks are stored against a position in the ORIGINAL clip's timeline; each half
         now starts at 0, so rebase them or they land in the wrong place. */
      let moved = 0;
      for (const r of STATE.ramps) {
        if (r.sourceId !== s0.id) continue;
        if (r.start >= at - 0.01) {
          r.sourceId = tail.id; r.sourceName = tail.name;
          r.start = Math.max(0, +(r.start - at).toFixed(3));
          moved++;
        } else {
          r.sourceId = head.id; r.sourceName = head.name;
          r.start = Math.max(0, +(r.start - lo).toFixed(3));
        }
      }
      /* Replace the one clip with its two halves, in place, keeping the order. */
      STATE.sources.splice(idx, 1, head, tail);
      saveState(STATE);

      /* No proxy job to wait for — the pieces ARE proxies, cut from one. Both halves
         are playable and exportable the instant this responds. */
      /* "Orphaned" must mean the CUT stranded a mark — not that the clip happens to be
         switched off. rampInVideo() is false for an off clip too, which reported both
         of Josh's disabled marks as orphaned by a split that stranded neither. */
      const strandedBySplit = r => {
        const src = STATE.sources.find(x => x.id === r.sourceId);
        if (!src) return true;
        return !(r.start + r.len > useIn(src) - 0.01 && r.start < useOut(src) + 0.01);
      };
      const orphaned = STATE.ramps.filter(r =>
        (r.sourceId === head.id || r.sourceId === tail.id) && strandedBySplit(r)).length;
      return sendJSON(res, { ok: true, sources: STATE.sources, moved, orphaned,
                             pieces: [{ name: head.name, duration: head.duration, bytes: head.bytes },
                                      { name: tail.name, duration: tail.duration, bytes: tail.bytes }],
                             plan: rampPlan() });
    }

    if (p === '/api/render' && req.method === 'POST') {
      const jid = 'render';
      /* The export screen sends the name he typed AND which chapters to include.
         Read both BEFORE the render starts — by the time the job finishes he may have
         switched chapters, and the film must land under the name he asked for. */
      const rb = JSON.parse((await readBody(req)).toString() || '{}');
      const wantName = rb.name;
      const wantIds = Array.isArray(rb.chapters) && rb.chapters.length
        ? rb.chapters : [STATE.chapterId];
      /* Whole film = every chapter ticked. Decided NOW, before the render — chapters can
         change while it runs. Only the whole film goes public; a one-chapter test export
         must never replace the published film (2026-09-27). */
      const wholeFilm = chapterList().every(c => wantIds.includes(c.id));
      jobs.set(jid, { status: 'working', pct: 0 });
      /* ⚠️ ONE copy step for BOTH modes and for one-or-many chapters, here at the single
         call site rather than at each render function's return — renderRamp and
         renderTimeline both end in `return path.basename(finalOut)`, and putting it in
         one of them is exactly how a fix reaches half the app (twice already). */
      renderChapters(wantIds, pct => jobs.set(jid, { status: 'working', pct }))
        .then(async file => {
          /* Copy to ~/Downloads so he can just find it. A failure here must NEVER
             fail the export — the film is already rendered and safe in media/out;
             report where it really is instead of throwing his work away. */
          let saved = null, saveError = null;
          try {
            await fsp.mkdir(DOWNLOADS, { recursive: true });
            const dest = await uniqueDownloadPath(file, wantName);
            await fsp.copyFile(path.join(OUT, file), dest);
            saved = path.basename(dest);
          } catch (e) { saveError = tidyErr(e); }
          jobs.set(jid, { status: 'done', pct: 100, file, saved, saveError, publishing: wholeFilm && !!process.env.MAGPIE_ON_EXPORT });
          /* Optional hook: set MAGPIE_ON_EXPORT to a script and every WHOLE-FILM export runs
             it with the film's path (e.g. to upload it to your site). Detached and
             best-effort: a failed hook must never fail the export. */
          if (wholeFilm && process.env.MAGPIE_ON_EXPORT) {
            const log = fs.openSync(path.join(MEDIA, 'on-export.log'), 'a');
            const pub = spawn(process.env.MAGPIE_ON_EXPORT, [path.join(OUT, file)], { stdio: ['ignore', log, log] });
            pub.on('close', code => {
              const j = jobs.get(jid);
              if (j && j.file === file) jobs.set(jid, { ...j, publishing: false,
                published: code === 0, publishError: code === 0 ? null : 'on-export hook failed' });
            });
          }
        })
        .catch(e => jobs.set(jid, { status: 'error', pct: 0, error: tidyErr(e) }));
      return sendJSON(res, { ok: true });
    }

    /* ---- MODE ----
       One file holds both modes. Switching does not discard the other's output. */
    /* Save where he is. Merged (never replaced) so an older client posting a
       subset cannot wipe keys it does not know about. Debounced on the client —
       the loop repaints ~60fps and must not write that often. */
    if (p === '/api/view' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const v = { ...EMPTY.view, ...(STATE.view || {}) };
      const num = (x, d) => (Number.isFinite(+x) ? +(+x).toFixed(3) : d);
      if (b.videoPos   != null) v.videoPos   = Math.max(0, num(b.videoPos, v.videoPos));
      if (b.chunkStart != null) v.chunkStart = Math.max(0, num(b.chunkStart, v.chunkStart));
      if (b.chunkLen   != null) v.chunkLen   = Math.max(0.1, num(b.chunkLen, v.chunkLen));
      if (b.audioPos   != null) v.audioPos   = Math.max(0, num(b.audioPos, v.audioPos));
      if (b.selected   !== undefined) v.selected = b.selected || null;
      if (b.screen != null) v.screen = ['output','files'].includes(b.screen) ? b.screen : 'input';
      if (b.loopAudio  != null) v.loopAudio = !!b.loopAudio;
      STATE.view = v;
      saveState(STATE);
      return sendJSON(res, { ok: true, view: v });
    }

    if (p === '/api/mode' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      /* ONE MODE FOR THE WHOLE PROJECT. Josh, 2026-09-23: "the idea of something being
         either in grab mode or speed mode is project level... it shouldn't switch between
         the chapters. It should just stay per project." So it is set on every chapter. */
      if (b.mode === 'grab' || b.mode === 'ramp') {
        STATE.mode = b.mode;
        for (const ch of (STATE.chapters || [])) ch.mode = b.mode;
        saveState(STATE);
      }
      return sendJSON(res, { ok: true, mode: STATE.mode });
    }

    /* ---- CHAPTERS ----
       One active at a time. Switching parks the live chapter's clips/audio/moments and
       lifts the next one's into their place, so the whole UI shows ONLY the chapter he
       is in — including the mode it was left in, because `mode` is per-chapter too. */
    if (p === '/api/chapters') {
      return sendJSON(res, { chapters: chapterList().map(chapterSummary),
                             activeId: STATE.chapterId });
    }
    if (p === '/api/chapter/new' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const all = chapterList();
      const maxOrd = all.reduce((a, c) => Math.max(a, c.ord ?? 0), 0);
      /* Park the current one and start the new one EMPTY and live — he asked for a
         chapter that "works exactly like chapter one" with "all this stuff out of the
         way", so a new chapter must not inherit the last one's clips or audio. */
      STATE.chapters = [...(STATE.chapters || []), packChapter()];
      const fresh = { ...chapterDefaults(),
                      mode: STATE.mode,          // a new chapter takes the PROJECT's mode
                      id: crypto.randomBytes(6).toString('hex'),
                      title: String(b.title || '').trim().slice(0, 60) || `Chapter ${all.length + 1}` };
      unpackChapter(fresh);
      STATE.chapterOrd = maxOrd + 1;
      saveState(STATE);
      return sendJSON(res, { ok: true, activeId: STATE.chapterId,
                             chapters: chapterList().map(chapterSummary) });
    }
    if (p === '/api/chapter/switch' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      if (!switchChapter(String(b.id || ''))) return sendJSON(res, { error: 'no such chapter' }, 404);
      saveState(STATE);
      return sendJSON(res, { ok: true, activeId: STATE.chapterId, state: STATE });
    }
    if (p === '/api/chapter/rename' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const title = String(b.title || '').trim().slice(0, 60);
      if (!title) return sendJSON(res, { error: 'give it a name' }, 400);
      const id = String(b.id || STATE.chapterId);
      if (id === STATE.chapterId) STATE.chapterTitle = title;
      else {
        const c = (STATE.chapters || []).find(x => x.id === id);
        if (!c) return sendJSON(res, { error: 'no such chapter' }, 404);
        c.title = title;
      }
      saveState(STATE);
      return sendJSON(res, { ok: true, chapters: chapterList().map(chapterSummary) });
    }
    if (p === '/api/chapter/delete' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const id = String(b.id || '');
      const all = chapterList();
      /* Never leave him with no chapter to be in — the app's whole state lives in the
         active one, so an empty list would be an app with nothing loaded. */
      if (all.length <= 1) return sendJSON(res, { error: 'that is the only chapter' }, 400);
      if (id === STATE.chapterId) {
        // deleting the live one: step onto a neighbour FIRST, then drop it
        const other = all.find(c => c.id !== id);
        switchChapter(other.id);
      }
      STATE.chapters = (STATE.chapters || []).filter(c => c.id !== id);
      saveState(STATE);
      return sendJSON(res, { ok: true, activeId: STATE.chapterId,
                             chapters: chapterList().map(chapterSummary) });
    }

    /* ---- RAMP mode: mark a window that plays at real speed ---- */
    if (p === '/api/ramp' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const src = STATE.sources.find(x => x.id === b.sourceId);
      if (!src) return sendJSON(res, { error: 'unknown source' }, 400);
      const len = Math.max(0.1, Number(b.len) || 1);
      let start = Math.max(0, Math.min((src.duration || 0) - len, Number(b.start) || 0));
      // audioAt = WHERE IN THE AUDIO this moment lands. The video before it is
      // compressed to arrive exactly here. Defaults to appending after the last mark.
      // default landing spot: after the last moment that is actually IN the film
      const usedOut = STATE.ramps.filter(markInFilm)
        .reduce((a, x) => Math.max(a, (x.audioAt || 0) + outLen(x)), 0);
      const aAt = (b.audioAt != null) ? Math.max(0, Number(b.audioAt) || 0) : usedOut;
      const r = { id: id8(), sourceId: src.id, sourceName: src.name,
                  start: +start.toFixed(3), len: +len.toFixed(3), rate: cleanRate(b.rate) || 1,
                  audioAt: +aAt.toFixed(3) };
      clampToAudio(r);
      STATE.ramps.push(r);
      STATE.ramps.sort((a, c) => (a.audioAt || 0) - (c.audioAt || 0));
      saveState(STATE);
      return sendJSON(res, { ok: true, ramp: r, ramps: STATE.ramps, plan: rampPlan() });
    }
    if (p === '/api/ramp' && req.method === 'DELETE') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      STATE.ramps = STATE.ramps.filter(r => r.id !== b.id);
      if (STATE.view && STATE.view.selected === b.id) STATE.view.selected = null;
      saveState(STATE);
      return sendJSON(res, { ok: true, ramps: STATE.ramps, plan: rampPlan() });
    }
    if (p === '/api/ramp/edit' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const r = STATE.ramps.find(x => x.id === b.id);
      if (!r) return sendJSON(res, { error: 'no such window' }, 400);
      const src = STATE.sources.find(x => x.id === r.sourceId);
      const dur = src?.duration || 1e9;
      if (b.len != null) r.len = Math.max(0.1, Math.min(dur, Number(b.len)));
      if (b.start != null) r.start = Number(b.start);
      if (b.audioAt != null) r.audioAt = +Math.max(0, Number(b.audioAt) || 0).toFixed(3);
      if (b.rate != null && cleanRate(b.rate)) r.rate = cleanRate(b.rate);   // same footage, new speed
      r.start = +Math.max(0, Math.min(dur - r.len, r.start)).toFixed(3);
      r.len = +r.len.toFixed(3);
      clampToAudio(r);
      STATE.ramps.sort((a, c) => (a.audioAt || 0) - (c.audioAt || 0));
      saveState(STATE);
      return sendJSON(res, { ok: true, ramps: STATE.ramps, plan: rampPlan() });
    }
    /* Rebuild a source's proxy onto the current canvas. Needed when the canvas
       changes (mixed dimensions silently corrupt the render). Marks reference TIME,
       not pixels, so nothing he made is affected. */
    if (p === '/api/reproxy' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const list = b.id ? STATE.sources.filter(x => x.id === b.id) : STATE.sources.slice();
      if (!list.length) return sendJSON(res, { error: 'no such source' }, 400);
      for (const src of list) {
        src.ready = false; src.failed = false;
        makeProxy(src.id, path.join(SOURCES, src.file), path.join(PROXIES, src.proxy), src.duration)
          .then(() => { const x = STATE.sources.find(y => y.id === src.id);
                        if (x) { x.ready = true; saveState(STATE); } })
          .catch(() => { const x = STATE.sources.find(y => y.id === src.id);
                         if (x) { x.failed = true; saveState(STATE); } });
      }
      saveState(STATE);
      return sendJSON(res, { ok: true, rebuilding: list.map(x => x.id) });
    }

    /* Transcribe the bed. Belongs to the AUDIO, so it outlives any video change. */
    if (p === '/api/transcribe' && req.method === 'POST') {
      const jid = 'transcribe';
      jobs.set(jid, { status: 'working', pct: 0 });
      transcribeBed(pct => jobs.set(jid, { status: 'working', pct }))
        .then(segs => jobs.set(jid, { status: 'done', pct: 100, count: segs.length }))
        .catch(e => jobs.set(jid, { status: 'error', pct: 0, error: tidyErr(e) }));
      return sendJSON(res, { ok: true });
    }
    /* Give every EXISTING caption line whisper's real per-word timings, in every chapter,
       without touching his text or line times (so hand edits survive). A line whose words
       no longer match its text falls back to spreading his words evenly (lineWords). */
    if (p === '/api/transcript/words' && req.method === 'POST') {
      const books = [STATE, ...(STATE.chapters || [])];
      const report = [];
      for (const bk of books) {
        const tr = bk.transcript || [];
        if (!tr.length || !(bk.audio || []).length) continue;
        const words = await whisperWords(bk.audio);
        const r = alignWords(tr, words);
        report.push({ chapter: bk === STATE ? STATE.chapterTitle : bk.title, lines: tr.length, ...r });
      }
      saveState(STATE);
      return sendJSON(res, { ok: true, report });
    }
    /* Edit one line, or clear the lot — whisper is close, not perfect. */
    if (p === '/api/transcript' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      if (b.clear) { STATE.transcript = []; saveState(STATE); return sendJSON(res, { ok: true, transcript: [] }); }
      const i = Number(b.index);
      if (!Number.isInteger(i) || !STATE.transcript[i]) return sendJSON(res, { error: 'no such line' }, 400);
      if (b.text != null) STATE.transcript[i].text = String(b.text).slice(0, 400);
      if (b.start != null) STATE.transcript[i].start = Math.max(0, +(+b.start).toFixed(2));
      if (b.end != null) STATE.transcript[i].end = Math.max(0, +(+b.end).toFixed(2));
      saveState(STATE);
      return sendJSON(res, { ok: true, transcript: STATE.transcript });
    }
    if (p === '/api/burn-subs' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      STATE.burnSubs = !!b.on;
      saveState(STATE);
      return sendJSON(res, { ok: true, burnSubs: STATE.burnSubs });
    }

    if (p === '/api/ramp/plan') return sendJSON(res, rampPlan());

    /* Named projects. The live document autosaves to project.json on every action;
       these let him keep more than one and come back to it. */
    if (p === '/api/projects') {
      const files = (await fsp.readdir(PROJECTS).catch(() => []))
        .filter(f => f.endsWith('.json'));
      const list = [];
      for (const f of files) {
        try {
          const j = JSON.parse(await fsp.readFile(path.join(PROJECTS, f), 'utf8'));
          const st = await fsp.stat(path.join(PROJECTS, f));
          list.push({ name: path.basename(f, '.json'),
                      chunks: (j.timeline || []).length,
                      seconds: +(j.timeline || []).reduce((a, c) => a + outLen(c), 0).toFixed(1),
                      saved: st.mtimeMs });
        } catch {}
      }
      list.sort((a, b) => b.saved - a.saved);
      return sendJSON(res, { projects: list, current: STATE.name || 'Untitled' });
    }
    if (p === '/api/project/save' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const name = safeName(b.name);
      STATE.name = name;
      saveState(STATE);
      await fsp.writeFile(projFile(name), JSON.stringify(STATE, null, 2));
      return sendJSON(res, { ok: true, name });
    }
    if (p === '/api/project/open' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const f = projFile(b.name);
      let j;
      try { j = JSON.parse(await fsp.readFile(f, 'utf8')); }
      catch { return sendJSON(res, { error: 'no project by that name' }, 404); }
      // ensureChapters: a project saved before chapters existed still opens into a valid
      // one-chapter document rather than one with no active chapter at all.
      STATE = ensureChapters({ ...freshEmpty(), ...j, name: safeName(b.name) });
      saveState(STATE);
      return sendJSON(res, { ok: true, state: STATE });
    }
    if (p === '/api/project/delete' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      await fsp.unlink(projFile(b.name)).catch(() => {});
      return sendJSON(res, { ok: true });
    }
    // past exports, newest first — so a render is never lost in browser downloads
    if (p === '/api/exports') {
      const files = (await fsp.readdir(OUT).catch(() => [])).filter(f => f.endsWith('.mp4'));
      const list = [];
      for (const f of files) {
        const st = await fsp.stat(path.join(OUT, f));
        list.push({ file: f, bytes: st.size, made: st.mtimeMs });
      }
      list.sort((a, b) => b.made - a.made);
      return sendJSON(res, { exports: list.slice(0, 20) });
    }

    if (p === '/api/reset' && req.method === 'POST') {
      /* Start over = ONE empty chapter, active. `{...EMPTY}` alone would leave
         chapterId null — no chapter active at all, so the strip would be empty and
         every chapter call would have nothing to act on until a reload re-ran the
         migration. Give it a real chapter here instead. */
      STATE = { ...freshEmpty(), chapters: [],
                chapterId: crypto.randomBytes(6).toString('hex'),
                chapterTitle: 'Intro', chapterOrd: 0 };
      saveState(STATE);
      return sendJSON(res, { ok: true });   // saved projects on disk are untouched
    }

    return send(res, 404, { error: 'no route' });
  } catch (e) {
    return sendJSON(res, { error: tidyErr(e) }, 500);
  }
});

const HOST = process.env.HOST || '127.0.0.1';   // HOST=0.0.0.0 to reach it from other devices
server.listen(PORT, HOST, () => {
  console.log(`Magpie on http://localhost:${PORT}`);
});
