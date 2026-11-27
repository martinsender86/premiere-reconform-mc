/*
 * ReconformMC - plugin UXP para Premiere 25.6 en adelante (Windows y Mac).
 * La lógica de matcheo vive en reconform-core.js.
 *
 * Cuatro modos:
 *   mc        Master clip -> Multicam            (como hasta la 1.7)
 *   merged    Master clip -> Merged clip
 *   mergedmc  Merged clip -> Multicam
 *   flatten   Flatten de merged clips (video y sonido sueltos)
 * Un merged es por dentro una secuencia (como una multicam): se lee con la API y, si no se
 * puede, del proyecto guardado (.prproj). Sin XML, sin preguntas, sin copias del proyecto.
 */
const ppro = require('premierepro');
const uxp = require('uxp');
const Core = require('./reconform-core.js');
const pako = require('./pako_inflate.min.js');
const C = ppro.Constants;
const VERSION = '2.4.7';

const MODES = {
	mc: {
		label: 'Master clip → Multicam', suffix: ' - MC', target: 'multicam', angles: true, probe: false, measure: true,
		analyze: 'Busca cada master clip dentro de las multicams del proyecto. No cambia nada.',
		runTitle: 'Reconformar', runButton: 'Reconformar en una copia',
		run: (n) => 'Crea «' + n + ' - MC» con las multicams. El original no se toca.'
	},
	merged: {
		label: 'Master clip → Merged', suffix: ' - Merged', target: 'merged clip', angles: false, probe: true, measure: false,
		analyze: 'Busca cada master clip dentro de los merged clips del proyecto. Solo lee: no crea ni cambia nada.',
		runTitle: 'Reconformar', runButton: 'Reconformar en una copia',
		run: (n) => 'Crea «' + n + ' - Merged» con los merged clips. El original no se toca.'
	},
	mergedmc: {
		label: 'Merged → Multicam', suffix: ' - MC', target: 'multicam', angles: true, probe: true, measure: true,
		analyze: 'Lee qué video y qué sonido tiene cada merged de la edición y los busca en las multicams. Solo lee: no crea ni cambia nada.',
		runTitle: 'Reconformar', runButton: 'Reconformar en una copia',
		run: (n) => 'Crea «' + n + ' - MC» con las multicams. El original no se toca.'
	},
	flatten: {
		label: 'Flatten Merged', suffix: ' - Flatten', target: 'archivo', angles: false, probe: true, measure: true,
		analyze: 'Lee de qué archivos está hecho cada merged de la edición. Solo lee: no crea ni cambia nada.',
		runTitle: 'Flatten', runButton: 'Hacer flatten en una copia',
		run: (n) => 'Crea «' + n + ' - Flatten» con el video y el sonido de cada merged sueltos. El original no se toca.'
	}
};

// Colores de etiqueta de Premiere, uno por cámara.
const CAM_COLORS = ['#3B9BD6', '#E8A33D', '#E37BAE', '#4FA45A', '#A68BD9', '#1DB3A6', '#D6C93B', '#C46A3B', '#8FA3B8'];
const camColor = (n) => CAM_COLORS[(n - 1) % CAM_COLORS.length];
const MERGED_COLOR = '#A68BD9', VIDEO_COLOR = '#3B9BD6', SOUND_COLOR = '#4FA45A';

const $ = (id) => document.getElementById(id);
const els = {
	version: $('version'), seqName: $('seqName'), seqDot: $('seqDot'), status: $('status'), progress: $('progress'),
	result: $('result'), map: $('map'), stats: $('stats'), cams: $('cams'), list: $('list'), log: $('log'),
	btnAnalyze: $('btnAnalyze'), btnRun: $('btnRun'), btnLog: $('btnLog'), modes: $('modes'),
	step1: $('step1'), step2: $('step2'), step3: $('step3'), num1: $('num1'), num2: $('num2'), num3: $('num3'),
	step1Text: $('step1Text'), modeNow: $('modeNow'), step2Text: $('step2Text'), step2Title: $('step2Title'), step3Text: $('step3Text')
};
let currentSeqName = null;   // secuencia activa en la timeline (se actualiza sola)
let analyzedSeqName = null;  // última secuencia analizada
let analyzedMode = null;
els.version.textContent = VERSION;

const STORE_KEY = 'reconformmc.state2';
const MODE_KEY = 'reconformmc.mode';
let state = loadState();   // { seqName, mode, entries: [{camera, trackIndex, start, end}] }
let mode = loadMode();

/* ---------------- utilidades ---------------- */

function log(text) { els.log.value += text + '\n'; }
function clearLog() { els.log.value = ''; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

let busy = false;
function setBusy(b) {
	busy = b;
	[els.btnAnalyze, els.btnRun].concat(modeButtons()).forEach((btn) => { if (b) { btn.setAttribute('disabled', ''); } else { btn.removeAttribute('disabled'); } });
	show(els.progress, b);
	if (!b) { els.progress.setAttribute('value', '0'); }
}
function show(el, visible) { if (visible) { el.classList.remove('hidden'); } else { el.classList.add('hidden'); } }
function setProgress(fraction) { els.progress.setAttribute('value', String(Math.round(fraction * 100))); }

function setStatus(html, kind) {
	els.status.className = 'status' + (kind ? ' ' + kind : '');
	els.status.classList.remove('hidden');
	els.status.innerHTML = html;
}

function markStep(n, done) {
	const step = els['step' + n], num = els['num' + n];
	if (done) { step.classList.add('done'); num.textContent = '✓'; }
	else { step.classList.remove('done'); num.textContent = String(n); }
}

function modeButtons() { return Array.from(els.modes.querySelectorAll('sp-action-button')); }

function loadMode() {
	try { const m = localStorage.getItem(MODE_KEY); return MODES[m] ? m : 'mc'; } catch (e) { return 'mc'; }
}
function setMode(m) {
	mode = m;
	try { localStorage.setItem(MODE_KEY, m); } catch (e) { /* sin persistencia */ }
	modeButtons().forEach((b) => { if (b.getAttribute('data-mode') === m) { b.setAttribute('selected', ''); } else { b.removeAttribute('selected'); } });
	els.modeNow.innerHTML = 'Modo: <b>' + escapeHtml(MODES[m].label) + '</b>';
	show(els.result, false);
	els.status.classList.add('hidden');
	refreshSteps();
}

// Los pasos reflejan lo hecho sobre la secuencia que está abierta ahora.
function refreshSteps() {
	const M = MODES[mode];
	const isCopy = !!(state && state.seqName && state.seqName === currentSeqName);
	const copyMode = isCopy ? (state.mode || 'mc') : null;
	const hasAngles = isCopy && MODES[copyMode] && MODES[copyMode].angles && state.entries && state.entries.length;
	els.step1Text.textContent = M.analyze;
	els.step2Title.textContent = M.runTitle;
	els.btnRun.textContent = M.runButton;
	// Una copia ya procesada se puede volver a reconformar: siempre hay botón (crea otra copia).
	const sameOp = isCopy && copyMode === mode;
	markStep(1, sameOp || (analyzedSeqName !== null && analyzedSeqName === currentSeqName && analyzedMode === mode));
	markStep(2, sameOp);
	show(els.btnRun, true);
	markStep(3, false);
	show(els.step3, M.angles || !!hasAngles);
	if (hasAngles) {
		els.step3.classList.remove('off');
		els.step3Text.textContent = 'Cada multicam entra en la cámara 1. Elegí una cámara para seleccionar sus cortes, después clic derecho → Multi-Camera → esa cámara.';
	} else {
		els.step3.classList.add('off');
		els.step3Text.textContent = 'Disponible después de reconformar.';
	}
	if (currentSeqName) {
		els.step2Text.textContent = (isCopy
			? (copyMode === 'flatten' ? 'Esta copia ya tiene el flatten hecho. ' : 'Esta copia ya está reconformada. ') + 'Si hace falta, se puede volver a procesar: '
			: '') + M.run(currentSeqName);
	}
	renderCameras(!!hasAngles);
}

async function pollActiveSequence() {
	if (busy) { return; }   // mientras trabaja, no se toca la interfaz
	const seq = await safe(async () => (await ppro.Project.getActiveProject()).getActiveSequence(), null);
	const name = seq ? seq.name : null;
	if (name === currentSeqName) { return; }
	currentSeqName = name;
	els.seqName.textContent = name || 'Sin secuencia abierta';
	if (name) { els.seqDot.classList.add('on'); } else { els.seqDot.classList.remove('on'); }
	refreshSteps();
}

function loadState() {
	try { return JSON.parse(localStorage.getItem(STORE_KEY)) || null; } catch (e) { return null; }
}
function saveState(s) {
	state = s;
	try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (e) { /* sin persistencia */ }
}

const tt = (ticks) => ppro.TickTime.createWithTicks(String(Math.round(ticks)));
const ticksOf = async (p) => (await p).ticksNumber;

function castClip(projectItem) {
	try { return ppro.ClipProjectItem.cast(projectItem) || null; } catch (e) { return null; }
}

async function safe(fn, fallback) {
	try { return await fn(); } catch (e) { return fallback; }
}
function trySync(fn) { try { return fn(); } catch (e) { return null; } }

function transaction(project, label, buildActions) {
	let ok = false;
	project.lockedAccess(() => {
		ok = project.executeTransaction((compound) => {
			buildActions().forEach((a) => compound.addAction(a));
		}, label);
	});
	return ok;
}

async function getTrackItems(track) {
	return (await track.getTrackItems(C.TrackItemType.CLIP, false)) || [];
}

async function seqEndTicks(seq) {
	return safe(async () => (await seq.getEndTime()).ticksNumber, 0);
}

// Prueba varias formas de hacer lo mismo (la API de Premiere cambió entre versiones).
function attempt(step, variants) {
	const errors = [];
	for (let i = 0; i < variants.length; i++) {
		try {
			const r = variants[i]();
			if (r !== false) { return i + 1; }
			errors.push('variante ' + (i + 1) + ': Premiere devolvió false');
		} catch (e) {
			errors.push('variante ' + (i + 1) + ': ' + (e && e.message ? e.message : e));
		}
	}
	throw new Error('Paso "' + step + '" falló.\n   ' + errors.join('\n   '));
}

/* ---------------- lectura del proyecto ---------------- */

// Recorre todo el proyecto una vez y separa multicams, merged clips y (si se pide) master clips con su archivo.
// Recorre todo el proyecto una vez y separa multicams, merged clips y (si se pide) master clips con su archivo.
// Un merged se reconoce de tres formas, porque no todas las versiones de Premiere responden igual:
//   1) isMergedClip() de la API;
//   2) es una secuencia (para la API un merged lo es), no es multicam y no está entre las secuencias reales;
//   3) el proyecto guardado (.prproj) lo marca como merged (BE.Sequence.IsMergedClip).
async function scanProject(project, withMedia) {
	const out = { multicams: [], merged: [], media: [], how: { api: 0, oculta: 0, proyecto: 0 } };
	const all = [], seqLike = [];
	async function walk(folder) {
		const items = await safe(() => folder.getItems(), []);
		for (const it of items) {
			const clip = castClip(it);
			if (clip) {
				clip._raw = it;
				if (await safe(() => clip.isMulticamClip(), false)) { out.multicams.push(clip); continue; }
				const path = await safe(() => clip.getMediaFilePath(), '');
				const isSeq = await safe(() => clip.isSequence(), false);
				const isMerged = await safe(() => clip.isMergedClip(), false);
				all.push({ clip, path, isSeq });
				if (isMerged) { addMerged(clip, path, 'api'); continue; }
				if (isSeq) { seqLike.push({ clip, path }); }
				if (withMedia && !isSeq && path) { out.media.push({ clip, path }); continue; }
				if (isSeq || path) { continue; }
			}
			let sub = null;
			try { sub = ppro.FolderItem.cast(it); } catch (e) { sub = null; }
			if (sub) {
				const children = await safe(() => sub.getItems(), null);
				if (Array.isArray(children)) { await walk(sub); }
			}
		}
	}
	function addMerged(clip, path, how) {
		if (out.merged.some((x) => x.key === clip.name)) { return; }
		out.merged.push({ key: clip.name, name: clip.name, clip, path });
		out.how[how]++;
	}
	await walk(await project.getRootItem());
	// 2) secuencias que no son secuencias de verdad
	if (seqLike.length) {
		const real = {};
		(await safe(() => project.getSequences(), [])).forEach((sq) => { real[sq.name] = true; });
		seqLike.forEach((x) => { if (!real[x.clip.name]) { addMerged(x.clip, x.path, 'oculta'); } });
	}
	// 3) lo que el proyecto guardado marca como merged
	const fileNames = await safe(async () => Core.readPrprojMergedNames(await readProjectText(project)), null);
	if (fileNames && fileNames.length) {
		const want = {};
		fileNames.forEach((n) => { want[n] = true; });
		all.forEach((x) => { if (want[x.clip.name]) { addMerged(x.clip, x.path, 'proyecto'); } });
	}
	// Lo que resultó ser merged no cuenta como master clip.
	const isM = {};
	out.merged.forEach((x) => { isM[x.name] = true; });
	out.media = out.media.filter((x) => !isM[x.clip.name]);
	return out;
}

// Timecode de origen del archivo, en ticks. Primero el que está grabado en el archivo
// (metadatos XMP); si no está, el que informa Premiere (26.5+). Se guarda por archivo.
const tcCache = {};
async function readStartTimecode(clip, mediaPath) {
	if (!clip) { return null; }
	const key = mediaPath || clip.name;
	if (Object.prototype.hasOwnProperty.call(tcCache, key)) { return tcCache[key]; }
	const xmp = await safe(() => ppro.Metadata.getXMPMetadata(clip._raw || clip), null);
	let tc = Core.parseXmpStartTimecode(xmp);
	if (tc === null) {
		const media = await safe(() => clip.getMedia(), null);
		const t = media ? await safe(async () => (typeof media.getStart === 'function' ? media.getStart() : await media.start), null) : null;
		if (t && typeof t.ticksNumber === 'number' && isFinite(t.ticksNumber)) { tc = t.ticksNumber; }
	}
	tcCache[key] = tc;
	return tc;
}

async function readClipTimes(ti, skipTc) {
	const raw = await ti.getProjectItem();
	const clip = castClip(raw);
	if (clip) { clip._raw = raw; }
	const mediaPath = clip ? await safe(() => clip.getMediaFilePath(), '') : '';
	return {
		ref: ti,
		projectItem: clip,
		name: await safe(() => ti.getName(), clip ? clip.name : ''),
		mediaPath: mediaPath,
		tc: skipTc ? null : await readStartTimecode(clip, mediaPath),
		start: await ticksOf(ti.getStartTime()),
		end: await ticksOf(ti.getEndTime()),
		inPoint: await ticksOf(ti.getInPoint()),
		outPoint: await ticksOf(ti.getOutPoint())
	};
}

async function readMulticams(mcItems) {
	const list = [];
	const byKey = {};
	for (let i = 0; i < mcItems.length; i++) {
		const mcClip = mcItems[i];
		const seq = await safe(() => mcClip.getSequence(), null);
		if (!seq) { continue; }
		const mc = { key: 'mc' + i, name: mcClip.name, cameras: [], audioOnly: [] };
		const camPaths = {};
		const vCount = await seq.getVideoTrackCount();
		for (let v = 0; v < vCount; v++) {
			for (const ti of await getTrackItems(await seq.getVideoTrack(v))) {
				const d = await readClipTimes(ti);
				d.cameraIndex = v;
				mc.cameras.push(d);
				camPaths[Core.normPath(d.mediaPath)] = true;
			}
		}
		const aCount = await seq.getAudioTrackCount();
		const seen = {};
		for (let a = 0; a < aCount; a++) {
			for (const ti of await getTrackItems(await seq.getAudioTrack(a))) {
				const d = await readClipTimes(ti);
				const key = Core.normPath(d.mediaPath);
				if (camPaths[key] || seen[key]) { continue; }
				seen[key] = true;
				mc.audioOnly.push(d);
			}
		}
		mc.audioTrackCount = aCount;   // estimación; al reconformar se mide de verdad
		list.push(mc);
		byKey[mc.key] = mcClip;
	}
	return { list, byKey };
}

async function readEdit(seq, m, mergedByName) {
	const needsMerged = m === 'mergedmc' || m === 'flatten';
	mergedByName = mergedByName || {};
	const items = [];
	const kinds = [
		['video', await seq.getVideoTrackCount(), (i) => seq.getVideoTrack(i)],
		['audio', await seq.getAudioTrackCount(), (i) => seq.getAudioTrack(i)]
	];
	for (const [kind, count, getTrack] of kinds) {
		for (let t = 0; t < count; t++) {
			for (const ti of await getTrackItems(await getTrack(t))) {
				const d = await readClipTimes(ti, needsMerged);
				d.kind = kind;
				d.trackIndex = t;
				d.speed = await safe(() => ti.getSpeed(), 1);
				d.disabled = await safe(() => ti.isDisabled(), false);
				const clip = d.projectItem;
				const isMC = clip ? await safe(() => clip.isMulticamClip(), false) : false;
				// Un merged también es una secuencia para la API: se pregunta antes. Y se reconoce
				// por nombre, por si la API devuelve otro item (cada pieza apunta a su archivo).
				const flag = clip && !isMC ? await safe(() => clip.isMergedClip(), false) : false;
				const mName = flag ? clip.name
					: (mergedByName[d.name] ? d.name : (clip && mergedByName[clip.name] ? clip.name : null));
				if (isMC) { d.skipReason = 'ya es una multicam'; }
				else if (mName) {
					if (needsMerged) {
						d.mergedKey = mName;
						d.groupKey = 'merged:' + mName;
						d.name = mName;
					} else { d.skipReason = m === 'merged' ? 'ya es un merged clip' : 'es un merged clip'; }
				}
				else if (!clip) { d.skipReason = 'no es un clip de media (gráfico, título, etc.)'; }
				else if (await safe(() => clip.isSequence(), false)) { d.skipReason = 'es una secuencia anidada'; }
				else if (needsMerged) { d.skipReason = 'no es un merged clip'; }
				else if (!d.mediaPath) { d.skipReason = 'no tiene archivo de media'; }
				items.push(d);
			}
		}
	}
	return items;
}


// In/out marcados en un clip del proyecto, para dejarlos como estaban al terminar.
// Se comparan con los del clip ya limpio: si son iguales, no tenía marcas (sirve también
// para merged y multicams, cuyo tiempo no siempre arranca en 0). Deja el clip sin marcas.
async function readMarks(project, clip) {
	const get = async (type) => ({ i: await clip.getInPoint(type), o: await clip.getOutPoint(type) });
	const read = async () => (await safe(() => get(C.MediaType.VIDEO), null)) || (await safe(() => get(C.MediaType.AUDIO), null));
	const ok = (r) => r && r.i && r.o && typeof r.i.ticksNumber === 'number' && typeof r.o.ticksNumber === 'number';
	const before = await read();
	trySync(() => transaction(project, 'ReconformMC: limpiar in/out', () => [clip.createClearInOutPointsAction()]));
	const clean = await read();
	if (!ok(before)) { return null; }
	if (ok(clean) && before.i.ticksNumber === clean.i.ticksNumber && before.o.ticksNumber === clean.o.ticksNumber) { return null; }
	return before;
}
function restoreMarks(project, clip, mark) {
	trySync(() => transaction(project, 'ReconformMC: restaurar in/out', () => [mark ? clip.createSetInOutPointsAction(mark.i, mark.o) : clip.createClearInOutPointsAction()]));
}

/* ---------------- merged clips: su secuencia interna ----------------
 * Un merged clip es por dentro una secuencia oculta, como una Multicamera Source Sequence.
 * Se lee igual que una multicam (getSequence). Si la API no la entrega, se lee del proyecto
 * guardado (.prproj), donde está la misma secuencia. No guarda, no pregunta, no crea nada.
 */
function utf8Decode(bytes) {
	if (typeof TextDecoder !== 'undefined') { try { return new TextDecoder('utf-8').decode(bytes); } catch (e) { /* sigue abajo */ } }
	let out = '', i = 0;
	while (i < bytes.length) {
		const c = bytes[i++];
		if (c < 0x80) { out += String.fromCharCode(c); }
		else if (c < 0xE0) { out += String.fromCharCode(((c & 0x1F) << 6) | (bytes[i++] & 0x3F)); }
		else if (c < 0xF0) { out += String.fromCharCode(((c & 0x0F) << 12) | ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F)); }
		else { let cp = ((c & 0x07) << 18) | ((bytes[i++] & 0x3F) << 12) | ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F); cp -= 0x10000; out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF)); }
	}
	return out;
}

async function readProjectText(project) {
	const path = project.path;
	if (!path) { throw new Error('el proyecto no tiene un archivo .prproj (¿Team Project o Production?)'); }
	let buf = null;
	try { buf = require('fs').readFileSync(path); } catch (e) { buf = null; }
	if (!buf) {
		const p = String(path).replace(/\\/g, '/');
		for (const u of ['file:' + path, 'file:' + p, 'file://' + p, 'file:///' + p.replace(/^\/+/, '')]) {
			try {
				const ent = await uxp.storage.localFileSystem.getEntryWithUrl(u);
				buf = await ent.read({ format: uxp.storage.formats.binary });
				if (buf) { break; }
			} catch (e) { buf = null; }
		}
	}
	if (!buf) { throw new Error('no pude abrir el archivo del proyecto'); }
	if (typeof buf === 'string') { return buf; }
	const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf)
		: (ArrayBuffer.isView(buf) ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : new Uint8Array(buf));
	if (bytes[0] === 0x1f && bytes[1] === 0x8b) { return pako.inflate(bytes, { to: 'string' }); }
	return utf8Decode(bytes);
}

// Lee la secuencia interna pieza por pieza: si una pieza no se deja leer, se anota y se sigue.
async function readMergedSequence(seq) {
	const out = { video: [], audio: [], failed: 0, noFile: 0, errors: [] };
	const note = (e) => { const t = e && e.message ? e.message : String(e); if (out.errors.indexOf(t) < 0 && out.errors.length < 3) { out.errors.push(t); } };
	const kinds = [
		['video', await safe(() => seq.getVideoTrackCount(), 0), (i) => seq.getVideoTrack(i)],
		['audio', await safe(() => seq.getAudioTrackCount(), 0), (i) => seq.getAudioTrack(i)]
	];
	for (const [kind, count, getTrack] of kinds) {
		for (let t = 0; t < count; t++) {
			let list = [];
			try { list = await getTrackItems(await getTrack(t)); } catch (e) { out.failed++; note(e); continue; }
			for (const ti of list) {
				let d = null;
				try { d = await readClipTimes(ti); } catch (e) { out.failed++; note(e); continue; }
				const it = { track: t, start: d.start, end: d.end, inPoint: d.inPoint, outPoint: d.outPoint, mediaPath: d.mediaPath, tc: d.tc };
				if (!d.mediaPath) {
					// Premiere no dice de qué archivo es: se guarda con qué nombres aparece, para buscarlo.
					out.noFile++;
					it.names = [d.projectItem ? d.projectItem.name : null, d.name].filter((x) => x);
					(out.unresolved = out.unresolved || []).push({ kind, it });
					continue;
				}
				out[kind].push(it);
			}
		}
	}
	return out;
}

// Busca un master clip del proyecto por nombre: el del clip, el del archivo o el source name.
let finderCache = null;
async function mediaFinder(project) {
	if (finderCache && finderCache.project === project) { return finderCache.find; }
	const scan = await scanProject(project, true);
	const byName = {}, byFile = {}, bySource = {};
	const lc = (x) => Core.normName(x).toLowerCase();
	const add = (dict, k, x) => { (dict[k] = dict[k] || []); if (!dict[k].some((y) => Core.normPath(y.path) === Core.normPath(x.path))) { dict[k].push(x); } };
	scan.media.forEach((x) => {
		add(byName, lc(x.clip.name), x);
		add(byFile, lc(Core.baseName(x.path)), x);
		add(bySource, lc(Core.sourceName(x.path)), x);
	});
	// Devuelve el master clip; si hay varios archivos distintos con ese nombre, lo avisa.
	const find = (names) => {
		for (const raw of names || []) {
			const n = lc(raw), noExt = n.replace(/\.[a-z0-9]{2,5}$/, '');
			const list = byFile[n] || byName[n] || bySource[noExt] || bySource[n];
			if (list && list.length) {
				if (list.length > 1) { list[0].ambiguous = list.length; }
				return list[0];
			}
		}
		return null;
	};
	finderCache = { project, find };
	return find;
}

// Lo leído de cada merged queda guardado mientras el panel está abierto.
const mergedCache = {};
async function readMerged(project, mergedAll) {
	const pkey = (m) => String(project.guid) + '|' + m.key;
	const out = { list: [], byKey: {}, failed: [] };
	const todo = [];
	mergedAll.forEach((m) => { const c = mergedCache[pkey(m)]; if (c) { out.list.push(c); out.byKey[c.key] = c; } else { todo.push(m); } });
	if (!todo.length) { return out; }
	log('\n-- Leyendo ' + todo.length + (todo.length === 1 ? ' merged clip' : ' merged clips') + ' --');
	const entries = [], fromFile = [], apiWhy = {}, apiPart = {};
	for (const m of todo) {
		let seq = null, r = null;
		try { seq = await m.clip.getSequence(); } catch (e) { apiWhy[m.key] = 'la API no da su secuencia (' + (e && e.message ? e.message : e) + ')'; }
		if (seq) {
			try { r = await readMergedSequence(seq); } catch (e) { apiWhy[m.key] = 'la API no deja leerla (' + (e && e.message ? e.message : e) + ')'; }
		} else if (!apiWhy[m.key]) { apiWhy[m.key] = 'la API no da su secuencia'; }
		// Piezas sin archivo: se buscan por nombre entre los master clips del proyecto.
		if (r && r.unresolved && r.unresolved.length) {
			const find = await mediaFinder(project);
			const left = [];
			for (const u of r.unresolved) {
				const x = find(u.it.names);
				if (x) {
					u.it.mediaPath = x.path;
					if (x.ambiguous) { log('  ' + m.name + ': hay ' + x.ambiguous + ' archivos distintos llamados ' + Core.baseName(x.path) + '; usé ' + x.path + ' (revisalo)'); }
					u.it.tc = await readStartTimecode(x.clip, x.path);
					r[u.kind].push(u.it);
					r.noFile--;
				} else { left.push(u); }
			}
			if (left.length < r.unresolved.length) { r.byName = r.unresolved.length - left.length; }
			r.unresolved = left;
			if (left.length) { r.unknownNames = left.map((u) => u.it.names.join(' / ') || '(sin nombre)'); }
		}
		const got = r ? r.video.length + r.audio.length : 0;
		if (r && got && !r.failed && !r.noFile) { entries.push({ key: m.key, name: m.name, video: r.video, audio: r.audio, via: r.byName ? 'nombre' : 'api' }); continue; }
		if (r) {
			apiWhy[m.key] = 'con la API leí ' + got + ' piezas' + (r.failed ? ', ' + r.failed + ' no se dejaron leer' : '') +
				(r.noFile ? ', ' + r.noFile + ' sin archivo' + (r.unknownNames ? ' (aparecen como: ' + r.unknownNames.slice(0, 4).join(', ') + ')' : '') : '') +
				(r.errors.length ? ' (' + r.errors.join('; ') + ')' : '');
		}
		if (r && got) { apiPart[m.key] = r; }
		fromFile.push(m);
	}
	if (fromFile.length) {
		let found = {}, why = null;
		const diag = {};
		try {
			const wanted = {};
			fromFile.forEach((m) => { wanted[m.name] = true; });
			found = Core.readPrprojMergedSeqs(await readProjectText(project), wanted, diag);
		} catch (e) { why = e && e.message ? e.message : String(e); }
		const scan = await scanProject(project, true);
		const byPath = {};
		scan.media.forEach((x) => { const k = Core.normPath(x.path); if (!byPath[k]) { byPath[k] = x; } });
		const tcOf = async (path) => { const x = byPath[Core.normPath(path)]; return x ? readStartTimecode(x.clip, x.path) : null; };
		for (const m of fromFile) {
			const f = found[m.name], part = apiPart[m.key];
			const nf = f ? f.video.length + f.audio.length : 0, np = part ? part.video.length + part.audio.length : 0;
			// Lo más completo de las dos lecturas.
			if (f && nf >= np) {
				for (const it of f.video.concat(f.audio)) { it.tc = await tcOf(it.mediaPath); }
				entries.push({ key: m.key, name: m.name, video: f.video, audio: f.audio, via: 'proyecto' });
				continue;
			}
			if (part) {
				log('  ' + m.name + ': ' + apiWhy[m.key] + '; sigo con lo que pude leer');
				entries.push({ key: m.key, name: m.name, video: part.video, audio: part.audio, via: 'api' });
				continue;
			}
			const fileWhy = why || diag[m.name] || 'no está en el proyecto guardado (si lo creaste recién, guardá y volvé a probar)';
			entries.push({ key: m.key, name: m.name, reason: (apiWhy[m.key] || 'la API no lo deja leer') + ' / ' + fileWhy });
		}
	}
	const res = Core.buildMergedTargetsFromSeq(entries);
	const via = {};
	entries.forEach((e) => { via[e.key] = e.via; });
	res.list.forEach((t) => {
		mergedCache[pkey(t)] = t;
		out.list.push(t); out.byKey[t.key] = t;
		log('  ' + t.name + ': ' + (t.cameras.length ? Core.baseName(t.cameras[0].mediaPath) + ' + ' : '') +
			t.audioOnly.map((a) => Core.baseName(a.mediaPath)).join(' + ') +
			(t.channels.some((c) => c.hasVideo) ? ' + audio de cámara' : '') + ' (' + t.channels.length + ' canales, leído ' +
			(via[t.key] === 'api' ? 'con la API' : via[t.key] === 'nombre' ? 'con la API; archivos buscados por nombre' : 'del proyecto guardado') + ')');
	});
	res.failed.forEach((f) => { out.failed.push(f); log('  ' + f.name + ': ' + f.reason); });
	return out;
}

/* ---------------- análisis ---------------- */

async function analyzeSequence(project, seq, m, onProgress) {
	Object.keys(tcCache).forEach((k) => { delete tcCache[k]; });
	// Se relee cada vez: el merged o el proyecto guardado pueden haber cambiado.
	Object.keys(mergedCache).forEach((k) => { delete mergedCache[k]; });
	finderCache = null;
	const M = MODES[m];
	const ticksPerFrame = Number(await seq.getTimebase());
	const tol = ticksPerFrame / 2;
	const seqEnd = await seqEndTicks(seq);
	const scan = await scanProject(project, m === 'flatten');
	log('Merged clips en el proyecto: ' + scan.merged.length +
		(scan.merged.length ? ' (por la API: ' + scan.how.api + ', por ser secuencia oculta: ' + scan.how.oculta + ', por el proyecto guardado: ' + scan.how.proyecto + ')' : '') +
		' | Multicams: ' + scan.multicams.length);
	const mergedByName = {};
	scan.merged.forEach((x) => { mergedByName[x.name] = x; });
	const edit = await readEdit(seq, m, mergedByName);
	const a = { mode: m, edit, ticksPerFrame, seqEnd, targetByKey: {}, targetData: {} };

	let mcs = null, merged = null;
	if (m === 'mc' || m === 'mergedmc') {
		mcs = await readMulticams(scan.multicams);
		a.targetByKey = mcs.byKey;
		mcs.list.forEach((x) => { a.targetData[x.key] = x; });
	}
	if (M.probe) {
		let list;
		if (m === 'merged') { list = scan.merged; }
		else {
			// solo los merged que están en la edición
			const byKey = {};
			scan.merged.forEach((x) => { byKey[x.key] = x; });
			const used = {};
			edit.forEach((d) => { if (d.mergedKey && !used[d.mergedKey] && byKey[d.mergedKey]) { used[d.mergedKey] = byKey[d.mergedKey]; } });
			list = Object.keys(used).map((k) => used[k]);
		}
		merged = await readMerged(project, list);
		a.merged = merged;
		if (m === 'merged') {
			list.forEach((x) => { a.targetByKey[x.key] = x.clip; });
			merged.list.forEach((x) => { a.targetData[x.key] = x; });
		}
	}

	if (m === 'mc') { a.replan = () => Core.plan(edit, mcs.list, { toleranceTicks: tol }); }
	else if (m === 'merged') { a.replan = () => Core.plan(edit, merged.list, { toleranceTicks: tol, label: 'merged clip', angles: false }); }
	else if (m === 'mergedmc') { a.replan = () => Core.plan(edit, mcs.list, { toleranceTicks: tol, mergedByKey: merged.byKey }); }
	else {
		// Flatten: los archivos de cada merged tienen que estar como master clips en el proyecto.
		const byPath = {};
		scan.media.forEach((x) => { const k = Core.normPath(x.path); if (!byPath[k]) { byPath[k] = x; } });
		const bySource = {};
		scan.media.forEach((x) => { const s = Core.sourceName(x.path); if (!bySource[s]) { bySource[s] = x; } });
		const clips = {};
		merged.list.forEach((t) => {
			Object.keys(t.files).forEach((k) => {
				if (clips[k]) { return; }
				const f = t.files[k];
				const found = byPath[k] || bySource[Core.sourceName(f.mediaPath)];
				if (!found) { return; }
				const key = 'clip:' + Core.normPath(found.path);
				clips[k] = { key, name: found.clip.name, mediaPath: found.path, hasVideo: f.hasVideo, audioTrackCount: f.audioChannels };
				a.targetByKey[key] = found.clip;
				a.targetData[key] = clips[k];
			});
		});
		a.replan = () => Core.planFlatten(edit, merged.byKey, clips, { toleranceTicks: tol });
	}
	{
		const plan0 = a.replan;
		const why = {};
		if (merged) { merged.failed.forEach((f) => { why[f.key] = f.reason; }); }
		a.replan = () => {
			const r = plan0();
			r.problems.forEach((pr) => { if (pr.match.status === 'nomerged' && why[pr.group.mergedKey]) { pr.match.detail = why[pr.group.mergedKey]; } });
			return r;
		};
	}
	a.result = a.replan();
	return a;
}

/* ---------------- edición ---------------- */

function removeWithSelection(project, editor, trackItems, mediaType, label, withShift) {
	let ok = false;
	project.lockedAccess(() => {
		ppro.TrackItemSelection.createEmptySelection((sel) => {
			trackItems.forEach((t) => sel.addItem(t, true));
			ok = project.executeTransaction((compound) => {
				compound.addAction(withShift
					? editor.createRemoveItemsAction(sel, false, mediaType, false)
					: editor.createRemoveItemsAction(sel, false, mediaType));
			}, label);
		});
	});
	return ok;
}

function removeItems(project, editor, items, label) {
	const video = items.filter((x) => x.kind === 'video').map((x) => x.ti);
	const audio = items.filter((x) => x.kind === 'audio').map((x) => x.ti);
	const bySeparate = (withShift) => {
		if (video.length && !removeWithSelection(project, editor, video, C.MediaType.VIDEO, 'ReconformMC: quitar imagen ' + label, withShift)) { return false; }
		if (audio.length && !removeWithSelection(project, editor, audio, C.MediaType.AUDIO, 'ReconformMC: quitar sonido ' + label, withShift)) { return false; }
		return true;
	};
	// Nunca pedir "todo tipo de medio" para una lista de un solo tipo: Premiere podría
	// llevarse también los clips vinculados del otro tipo.
	if (!video.length || !audio.length) {
		return attempt('quitar ' + label, [() => bySeparate(true), () => bySeparate(false)]);
	}
	return attempt('quitar ' + label, [
		() => removeWithSelection(project, editor, video.concat(audio), C.MediaType.ANY, 'ReconformMC: quitar ' + label, true),
		() => bySeparate(true),
		() => bySeparate(false)
	]);
}

function setClipInOut(project, clip, inT, outT) {
	return attempt('marcar in/out en ' + clip.name, [
		() => transaction(project, 'ReconformMC: in/out', () => [clip.createSetInOutPointsAction(tt(inT), tt(outT))]),
		() => transaction(project, 'ReconformMC: in/out', () => [clip.createSetInPointAction(tt(inT)), clip.createSetOutPointAction(tt(outT))]),
		() => transaction(project, 'ReconformMC: in', () => [clip.createSetInPointAction(tt(inT))]) &&
		      transaction(project, 'ReconformMC: out', () => [clip.createSetOutPointAction(tt(outT))])
	]);
}

function overwriteItem(project, editor, clip, start, vIdx, aIdx) {
	const raw = clip._raw || clip;
	const label = 'ReconformMC: poner ' + clip.name;
	return attempt('poner ' + clip.name, [
		() => transaction(project, label, () => [editor.createOverwriteItemAction(raw, tt(start), vIdx, aIdx)]),
		() => transaction(project, label, () => [editor.createOverwriteItemAction(clip, tt(start), vIdx, aIdx)]),
		() => transaction(project, label, () => [editor.createOverwriteItemAction(raw, ppro.TickTime.createWithSeconds(start / Core.TICKS_PER_SECOND), vIdx, aIdx)])
	]);
}

// Items que arrancan en 'start' y pertenecen a un clip. Un merged puesto en la timeline deja
// piezas que apuntan a sus archivos: se reconocen por el nombre del clip del proyecto, por el
// nombre del track item o por el de sus archivos (names puede ser un nombre o una lista).
async function findPlacedItems(seq, names, start, tol) {
	const want = {};
	(Array.isArray(names) ? names : [names]).forEach((n) => { if (n) { want[n] = true; } });
	const found = { video: [], audio: [] };
	const groups = [
		['video', await seq.getVideoTrackCount(), (i) => seq.getVideoTrack(i)],
		['audio', await seq.getAudioTrackCount(), (i) => seq.getAudioTrack(i)]
	];
	for (const [kind, count, getTrack] of groups) {
		for (let t = 0; t < count; t++) {
			for (const ti of await getTrackItems(await getTrack(t))) {
				if (Math.abs((await ticksOf(ti.getStartTime())) - start) > tol) { continue; }
				const clip = castClip(await ti.getProjectItem());
				const tiName = await safe(() => ti.getName(), null);
				if ((clip && want[clip.name]) || (tiName && want[tiName])) { found[kind].push({ ti, trackIndex: t }); }
			}
		}
	}
	return found;
}

async function cloneSequence(project, src, newName) {
	const before = {};
	(await project.getSequences()).forEach((s) => { before[String(s.guid)] = true; });
	if (!transaction(project, 'ReconformMC: duplicar secuencia', () => [src.createCloneAction()])) {
		throw new Error('No se pudo duplicar la secuencia.');
	}
	const clone = (await project.getSequences()).find((s) => !before[String(s.guid)]);
	if (!clone) { throw new Error('No encontré la copia de la secuencia.'); }
	await safe(async () => {
		const pi = castClip(await clone.getProjectItem());
		if (pi) { transaction(project, 'ReconformMC: renombrar copia', () => [pi.createSetNameAction(newName)]); }
	}, null);
	await project.openSequence(clone);
	await project.setActiveSequence(clone);
	return clone;
}

// Pasa un clip a otro track (mismo tiempo): lo duplica corrido y borra el original.
function moveToTrack(project, editor, ti, audioOffset, name) {
	attempt('bajar ' + name, [
		() => transaction(project, 'ReconformMC: bajar ' + name, () => [editor.createCloneTrackItemAction(ti, tt(0), 0, audioOffset, false, false)])
	]);
	removeItems(project, editor, [{ ti, kind: 'audio' }], name);
}

// Track items que arrancan en 'start' (cualquier nombre), con lo necesario para compararlos.
async function itemsAt(seq, start, tol) {
	const out = [];
	const groups = [
		['video', await seq.getVideoTrackCount(), (i) => seq.getVideoTrack(i)],
		['audio', await seq.getAudioTrackCount(), (i) => seq.getAudioTrack(i)]
	];
	for (const [kind, count, getTrack] of groups) {
		for (let t = 0; t < count; t++) {
			for (const ti of await getTrackItems(await getTrack(t))) {
				const st = await ticksOf(ti.getStartTime());
				if (Math.abs(st - start) > tol) { continue; }
				const en = await ticksOf(ti.getEndTime());
				out.push({ ti, kind, trackIndex: t, start: st, end: en, sig: kind + '|' + t + '|' + Math.round(st) + '|' + Math.round(en) });
			}
		}
	}
	return out;
}

// Describe lo que hay cerca de un instante (para el detalle técnico cuando algo no aparece).
async function describeAround(seq, at, tpf) {
	const lines = [];
	const groups = [
		['V', await seq.getVideoTrackCount(), (i) => seq.getVideoTrack(i)],
		['A', await seq.getAudioTrackCount(), (i) => seq.getAudioTrack(i)]
	];
	const fps = Math.round(Core.TICKS_PER_SECOND / tpf);
	for (const [k, count, getTrack] of groups) {
		for (let t = 0; t < count; t++) {
			for (const ti of await getTrackItems(await getTrack(t))) {
				const st = await ticksOf(ti.getStartTime()), en = await ticksOf(ti.getEndTime());
				if (en < at - tpf * 50 || st > at + tpf * 50) { continue; }
				const pi = await safe(() => ti.getProjectItem(), null);
				const pname = pi ? (pi.name || '?') : '(sin item)';
				const tname = await safe(() => ti.getName(), '?');
				lines.push('    ' + k + (t + 1) + '  ' + Core.ticksToTC(st, tpf, fps) + '-' + Core.ticksToTC(en, tpf, fps) +
					'  item: "' + tname + '"  proyecto: "' + pname + '"  in ' + Core.ticksToTC(await ticksOf(ti.getInPoint()), tpf, fps));
			}
		}
	}
	return lines.length ? lines.join('\n') : '    (no hay nada)';
}

// Pone un clip y devuelve exactamente lo que apareció en la timeline (comparando antes y después),
// sin depender de cómo se llamen las piezas. Si una forma de poner no deja nada, prueba la siguiente.
async function placeAndFind(project, editor, seq, clip, start, vIdx, aIdx, tol) {
	const raw = clip._raw || clip;
	const label = 'ReconformMC: poner ' + clip.name;
	const ways = [
		() => transaction(project, label, () => [editor.createOverwriteItemAction(raw, tt(start), vIdx, aIdx)]),
		() => transaction(project, label, () => [editor.createOverwriteItemAction(clip, tt(start), vIdx, aIdx)]),
		() => transaction(project, label, () => [editor.createOverwriteItemAction(raw, ppro.TickTime.createWithSeconds(start / Core.TICKS_PER_SECOND), vIdx, aIdx)])
	];
	const errors = [];
	for (let w = 0; w < ways.length; w++) {
		const before = {};
		(await itemsAt(seq, start, tol)).forEach((x) => { before[x.sig] = true; });
		try {
			if (ways[w]() === false) { errors.push('forma ' + (w + 1) + ': Premiere devolvió false'); continue; }
		} catch (e) { errors.push('forma ' + (w + 1) + ': ' + (e && e.message ? e.message : e)); continue; }
		const fresh = (await itemsAt(seq, start, tol)).filter((x) => !before[x.sig]);
		if (fresh.length) {
			if (w > 0) { log('    (' + clip.name + ': entró con la forma ' + (w + 1) + ')'); }
			return { video: fresh.filter((x) => x.kind === 'video'), audio: fresh.filter((x) => x.kind === 'audio'), errors };
		}
		errors.push('forma ' + (w + 1) + ': no apareció nada en la timeline');
	}
	return { video: [], audio: [], errors };
}

// Todos los track items que arrancan desde 'from' (o todos), con firma para comparar antes/después.
async function itemsFrom(seq, from) {
	const out = [];
	const groups = [
		['video', await seq.getVideoTrackCount(), (i) => seq.getVideoTrack(i)],
		['audio', await seq.getAudioTrackCount(), (i) => seq.getAudioTrack(i)]
	];
	for (const [kind, count, getTrack] of groups) {
		for (let t = 0; t < count; t++) {
			for (const ti of await getTrackItems(await getTrack(t))) {
				const st = await ticksOf(ti.getStartTime());
				if (from !== null && st < from) { continue; }
				const en = await ticksOf(ti.getEndTime());
				out.push({ ti, kind, trackIndex: t, start: st, end: en, sig: kind + '|' + t + '|' + Math.round(st) + '|' + Math.round(en) });
			}
		}
	}
	return out;
}
const sigSet = (list) => { const o = {}; list.forEach((x) => { o[x.sig] = true; }); return o; };
const splitKinds = (list) => ({ video: list.filter((x) => x.kind === 'video'), audio: list.filter((x) => x.kind === 'audio') });

function overwriteWays(project, editor, clip, time, vIdx, aIdx) {
	const raw = clip._raw || clip, label = 'ReconformMC: poner ' + clip.name;
	return [
		() => transaction(project, label, () => [editor.createOverwriteItemAction(raw, tt(time), vIdx, aIdx)]),
		() => transaction(project, label, () => [editor.createOverwriteItemAction(clip, tt(time), vIdx, aIdx)])
	];
}

// Lleva items (que cayeron en otro lado) a su lugar: los duplica corridos y borra los de origen.
async function relocate(project, editor, seq, items, delta, tol) {
	const descs = items.map((x) => ({ kind: x.kind, trackIndex: x.trackIndex, start: x.start }));
	for (const d of descs) {
		const target = d.start + delta;
		if ((await itemsAt(seq, target, tol)).some((x) => x.kind === d.kind && x.trackIndex === d.trackIndex)) { continue; }   // ya llegó
		const src = (await itemsAt(seq, d.start, tol)).find((x) => x.kind === d.kind && x.trackIndex === d.trackIndex);   // referencia nueva
		if (src) { transaction(project, 'ReconformMC: ubicar', () => [editor.createCloneTrackItemAction(src.ti, tt(delta), 0, 0, false, false)]); }
	}
	// Borrar lo de origen con referencias nuevas, imagen y sonido por separado.
	for (const kind of ['video', 'audio']) {
		const left = [];
		for (const d of descs.filter((x) => x.kind === kind)) {
			const it = (await itemsAt(seq, d.start, tol)).find((x) => x.kind === d.kind && x.trackIndex === d.trackIndex);
			if (it) { left.push({ ti: it.ti, kind }); }
		}
		if (left.length) { removeItems(project, editor, left, 'ubicar'); }
	}
}

/*
 * Pone un merged en 'target'. Premiere, al poner un merged, lo corre tanto como su in
 * (cae en tiempo pedido + in). Se pide la posición compensada; si quedaría antes del
 * principio de la secuencia, se pone en un lugar libre al final y se lleva a su lugar.
 * Siempre se verifica qué apareció y dónde.
 */
async function placeMerged(project, editor, seq, clip, target, vIdx, aIdx, shift, tpf, kind) {
	const tol = tpf / 2, req = target - shift;
	// Pedir solo lo que hace falta (imagen o sonido) para no tener que borrar sobrantes.
	const tracks = kind === 'video' ? [[vIdx, -1], [vIdx, aIdx]] : kind === 'audio' ? [[-1, aIdx], [vIdx, aIdx]] : [[vIdx, aIdx]];
	const tryWays = (time) => tracks.flatMap(([v, a]) => overwriteWays(project, editor, clip, time, v, a));
	if (req >= 0) {
		const before = sigSet(await itemsFrom(seq, null));
		for (const way of tryWays(req)) {
			try { if (way() === false) { continue; } } catch (e) { continue; }
			const fresh = (await itemsFrom(seq, null)).filter((x) => !before[x.sig]);
			if (!fresh.length) { continue; }
			const land = Math.min.apply(null, fresh.map((x) => x.start));
			if (Math.abs(land - target) > tol) {
				log('    (' + clip.name + ' cayó corrido ' + Math.round((land - target) / tpf) + ' cuadros; se lleva a su lugar)');
				await relocate(project, editor, seq, fresh, target - land, tol);
				return splitKinds(await itemsAt(seq, target, tol).then((l) => l.filter((x) => !before[x.sig])));
			}
			return splitKinds(fresh);
		}
	}
	// Al final de la secuencia, donde no hay nada, y después a su lugar.
	const T = Math.ceil((await seqEndTicks(seq)) / tpf) * tpf + tpf * 50;
	const beforeT = sigSet(await itemsFrom(seq, T - tol));
	const beforeAt = sigSet(await itemsAt(seq, target, tol));
	for (const way of tryWays(T)) {
		try { if (way() === false) { continue; } } catch (e) { continue; }
		const fresh = (await itemsFrom(seq, T - tol)).filter((x) => !beforeT[x.sig]);
		if (!fresh.length) { continue; }
		const land = Math.min.apply(null, fresh.map((x) => x.start));
		await relocate(project, editor, seq, fresh, target - land, tol);
		return splitKinds((await itemsAt(seq, target, tol)).filter((x) => !beforeAt[x.sig]));
	}
	return { video: [], audio: [], errors: ['no apareció nada en la timeline'] };
}

// Mide cuántos tracks de audio ocupa un clip (multicam, merged o master clip) al ponerlo en
// la timeline (depende de cómo está configurada su salida de audio). Lo pone un instante
// después del final de la secuencia, cuenta y lo saca.
async function measureAudioWidth(project, editor, seq, clip, inTicks, tpf, names) {
	const tol = tpf / 2;
	const end = await seqEndTicks(seq);
	const at = Math.ceil(end / tpf) * tpf + tpf * 50;
	setClipInOut(project, clip, inTicks, inTicks + tpf * 5);
	const before = sigSet(await itemsFrom(seq, at - tol));
	let fresh = [], errors = [];
	for (const way of overwriteWays(project, editor, clip, at, 0, 0)) {
		try { if (way() === false) { errors.push('Premiere devolvió false'); continue; } } catch (e) { errors.push(e && e.message ? e.message : String(e)); continue; }
		fresh = (await itemsFrom(seq, at - tol)).filter((x) => !before[x.sig]);
		if (fresh.length) { break; }
		errors.push('no apareció nada');
	}
	if (!fresh.length) {
		log('  ' + clip.name + ': al ponerlo no apareció nada (' + errors.join('; ') + ')\n  Lo que hay ahí:\n' + await describeAround(seq, at, tpf));
		return { width: null, shift: null };
	}
	const land = Math.min.apply(null, fresh.map((x) => x.start));
	const tracks = fresh.filter((x) => x.kind === 'audio').map((x) => x.trackIndex);
	removeItems(project, editor, fresh.map((x) => ({ ti: x.ti, kind: x.kind })), 'medición');
	const width = tracks.length ? Math.max.apply(null, tracks) - Math.min.apply(null, tracks) + 1 : 0;
	return { width, shift: land - at };
}

async function reconform(m) {
	const M = MODES[m];
	const project = await ppro.Project.getActiveProject();
	const src = await project.getActiveSequence();
	if (!src) { throw new Error('Abrí la secuencia editada en la timeline.'); }

	setStatus('Duplicando «' + escapeHtml(src.name) + '»…', 'work');
	log('ReconformMC ' + VERSION + ' — ' + M.label + '\nDuplicando "' + src.name + '"…');
	const seq = await cloneSequence(project, src, src.name + M.suffix);
	currentSeqName = seq.name;
	els.seqName.textContent = seq.name;

	if (M.probe) { setStatus('Leyendo cómo está armado cada merged…', 'work'); }
	const analysis = await analyzeSequence(project, seq, m, setProgress);
	setProgress(0);
	const { ticksPerFrame, targetByKey } = analysis;
	let result = analysis.result;
	if (!result.placements.length) {
		// No hay nada que hacer: la copia se borra y se vuelve al original.
		renderResult(analysis);
		await safe(() => project.deleteSequence(seq), false);
		await safe(() => project.openSequence(src), false);
		await safe(() => project.setActiveSequence(src), false);
		const hint = modeHint(result, m);
		setStatus('No hay cortes para reemplazar con <b>' + escapeHtml(M.label) + '</b>. No se creó ninguna copia.' + (hint ? '<br>' + hint : ''), 'error');
		return;
	}

	const editor = ppro.SequenceEditor.getEditor(seq);
	const tol = ticksPerFrame / 2;
	const fps = Math.round(Core.TICKS_PER_SECOND / ticksPerFrame);
	const usedTargets = {};
	let lastOpened = null;
	async function openInSource(key) {
		if (lastOpened === key) { return; }
		await safe(() => ppro.SourceMonitor.openProjectItem(targetByKey[key]._raw || targetByKey[key]), false);
		await sleep(200);
		lastOpened = key;
	}
	// Nombres con los que aparece en la timeline lo que se pone (para un merged, también sus archivos).
	const namesOf = (key) => {
		const out = [targetByKey[key].name], d = analysis.targetData[key];
		if (d && d.kind === 'merged' && d.files) { Object.keys(d.files).forEach((k) => out.push(d.files[k].name)); }
		return out;
	};
	async function useTarget(key) {
		if (!usedTargets[key]) { usedTargets[key] = { clip: targetByKey[key], mark: await readMarks(project, targetByKey[key]) }; }
		return targetByKey[key];
	}

	const broken = [];
	const camEntries = [];
	let done = 0;
	let extraTracks = false;
	try {
	// 1) Medir cuántos tracks de audio ocupa cada destino y rehacer el reparto de tracks.
	//    (Los merged se miden igual, poniéndolos un momento en la copia.)
	if (M.measure || m === 'merged') {
		setStatus('Midiendo el audio de ' + (m === 'flatten' ? 'los archivos' : 'las multicams') + '…', 'work');
		log('\n-- Canales de audio de cada ' + (m === 'flatten' ? 'archivo' : m === 'merged' ? 'merged' : 'multicam') + ' --');
		const firstUse = {};
		result.placements.forEach((p) => { if (!firstUse[p.match.mcKey]) { firstUse[p.match.mcKey] = p; } });
		for (const key of Object.keys(firstUse)) {
			const clip = await useTarget(key);
			await openInSource(key);
			const meas = await measureAudioWidth(project, editor, seq, clip, firstUse[key].match.mcIn, ticksPerFrame, namesOf(key));
			const width = meas.width;
			const data = analysis.targetData[key];
			if (width !== null && data) { data.audioTrackCount = width; }
			// Corrimiento al poner (un merged cae corrido tanto como su in): se anota lo que sobra.
			if (data && meas.shift !== null) {
				// Si no cae corrido, no se compensa; si cae corrido, es su in (más lo que sobre).
				data.shiftNone = Math.abs(meas.shift) <= ticksPerFrame / 2;
				data.shiftExtra = data.shiftNone ? 0 : meas.shift - firstUse[key].match.mcIn;
			}
			if (meas.shift && Math.abs(meas.shift) > ticksPerFrame / 2) { log('    (al ponerlo cae corrido ' + Math.round(meas.shift / ticksPerFrame) + ' cuadros; se compensa)'); }
			log('  ' + clip.name + ': ' + (width !== null ? width + ' tracks' : 'no se pudo medir, uso ' + (data ? data.audioTrackCount : '?')));
		}
		result = analysis.replan();
		analysis.result = result;
	}
	log('\n' + Core.report(result, ticksPerFrame));
	renderResult(analysis);

	// 2) Sacar todo lo que se va a reemplazar. Así ningún clip viejo queda en el camino de uno nuevo.
	setStatus('Quitando los clips originales…', 'work');
	const removedGroups = new Set();
	for (const p of result.placements) {
		const g = p.group;
		if (removedGroups.has(g)) { continue; }   // en flatten un corte genera imagen y sonido
		removedGroups.add(g);
		const originals = g.video.map((it) => ({ ti: it.ref, kind: 'video' }))
			.concat(g.audio.map((it) => ({ ti: it.ref, kind: 'audio' })));
		removeItems(project, editor, originals, g.name);
	}

	// 3) Mover los sonidos que quedan como estaban a su carril nuevo. Primero los que suben
	//    (de arriba hacia abajo), después los que bajan (de abajo hacia arriba), para que
	//    ninguno caiga sobre otro.
	const allMoves = result.fixedMoves || [];
	const moves = allMoves.filter((x) => x.to < x.from).sort((x, y) => x.from - y.from)
		.concat(allMoves.filter((x) => x.to > x.from).sort((x, y) => y.from - x.from));
	for (const mv of moves) {
		moveToTrack(project, editor, mv.item.ref, mv.to - mv.from, mv.item.name);
		log('  ' + mv.item.name + ': A' + (mv.from + 1) + ' → A' + (mv.to + 1));
	}

	// 4) Poner los destinos. Primero los cortes solo de sonido, después el resto.
	//    La parte que Premiere trae de más (la imagen de un corte solo de sonido, o el
	//    sonido de uno solo de imagen) se pone en tracks libres en ese tramo y se borra.
	const order = result.placements.filter((p) => p.kind === 'audio')
		.concat(result.placements.filter((p) => p.kind !== 'audio'));
	log('\n-- Ejecutando --');
	for (const p of order) {
		const tag = '#' + p.id + ' ' + Core.ticksToTC(p.start, ticksPerFrame, fps);
		try {
		const clip = await useTarget(p.match.mcKey);
		setStatus('Poniendo ' + (done + 1) + ' de ' + result.placements.length + '…', 'work');

		await openInSource(p.match.mcKey);
		setClipInOut(project, clip, p.match.mcIn, p.match.mcOut);

		let vIdx = p.kind === 'audio' ? p.discardVideoTrack : p.videoTrack;
		let aIdx = p.kind === 'video' ? p.discardAudioTrack : p.audioTrack;
		const noSpareVideo = p.kind === 'audio' && p.targetHasVideo === false;   // un wav no trae imagen
		const noSpareAudio = p.kind === 'video' && p.audioTracks === 0;          // un video sin sonido
		if (noSpareVideo) { vIdx = 0; }
		if (noSpareAudio) { aIdx = 0; }
		// Si no hay lugar libre para la parte que sobra (haría falta un track nuevo),
		// primero se prueba pedirle a Premiere que no la traiga.
		let skippedPart = false;
		const isMergedTarget = !!(analysis.targetData[p.match.mcKey] && analysis.targetData[p.match.mcKey].kind === 'merged');
		const beforeSig = {};
		(await itemsAt(seq, p.start, tol)).forEach((x) => { beforeSig[x.sig] = true; });
		if (!isMergedTarget && p.kind === 'video' && !noSpareAudio && aIdx + p.audioTracks > await seq.getAudioTrackCount()) {
			try { skippedPart = transaction(project, 'ReconformMC: poner ' + clip.name, () => [editor.createOverwriteItemAction(clip._raw || clip, tt(p.start), vIdx, -1)]); }
			catch (e) { skippedPart = false; }
		}
		if (!isMergedTarget && p.kind === 'audio' && !noSpareVideo && vIdx >= await seq.getVideoTrackCount()) {
			try { skippedPart = transaction(project, 'ReconformMC: poner ' + clip.name, () => [editor.createOverwriteItemAction(clip._raw || clip, tt(p.start), -1, aIdx)]); }
			catch (e) { skippedPart = false; }
		}
		if (!skippedPart &&
		    ((p.kind === 'video' && !noSpareAudio && aIdx + p.audioTracks > await seq.getAudioTrackCount()) ||
		     (p.kind === 'audio' && !noSpareVideo && vIdx >= await seq.getVideoTrackCount()))) { extraTracks = true; }
		let placed;
		const tdata = analysis.targetData[p.match.mcKey];
		if (!skippedPart && tdata && tdata.kind === 'merged') {
			placed = await placeMerged(project, editor, seq, clip, p.start, vIdx, aIdx, (tdata.shiftNone ? 0 : p.match.mcIn + (tdata.shiftExtra || 0)), ticksPerFrame, p.kind);
		} else if (!skippedPart) {
			placed = await placeAndFind(project, editor, seq, clip, p.start, vIdx, aIdx, tol);
		} else {
			if (p.kind === 'video') { aIdx = 0; } else { vIdx = 0; }
			const fresh = (await itemsAt(seq, p.start, tol)).filter((x) => !beforeSig[x.sig]);
			placed = { video: fresh.filter((x) => x.kind === 'video'), audio: fresh.filter((x) => x.kind === 'audio'), errors: [] };
		}
		if (!placed.video.length && !placed.audio.length) {
			log('  ' + tag + ' ' + clip.name + ': al ponerlo no apareció nada (' + (placed.errors || []).join('; ') + ')\n  Lo que hay ahí:\n' + await describeAround(seq, p.start, ticksPerFrame));
		}

		if (p.kind === 'video') {
			const spare = skippedPart ? placed.audio : placed.audio.filter((x) => x.trackIndex >= aIdx && x.trackIndex < aIdx + p.audioTracks);
			if (spare.length) { removeItems(project, editor, spare.map((x) => ({ ti: x.ti, kind: 'audio' })), 'sonido que sobra'); }
		}
		if (p.kind === 'audio' && !noSpareVideo) {
			const spare = skippedPart ? placed.video : placed.video.filter((x) => x.trackIndex === vIdx);
			if (spare.length) { removeItems(project, editor, spare.map((x) => ({ ti: x.ti, kind: 'video' })), 'imagen que sobra'); }
		}
		// Después de borrar, Premiere invalida las referencias a los clips vinculados: se vuelve a leer.
		placed = splitKinds((await itemsAt(seq, p.start, tol)).filter((x) => !beforeSig[x.sig]));

		const main = p.kind === 'audio' ? placed.audio.find((x) => x.trackIndex === p.audioTrack) : placed.video.find((x) => x.trackIndex === p.videoTrack);
		if (!main) {
			log('  ' + tag + ': lo que apareció: ' + (placed.video.map((x) => 'V' + (x.trackIndex + 1)).concat(placed.audio.map((x) => 'A' + (x.trackIndex + 1))).join(' ') || 'nada') +
				' | esperaba ' + (p.kind === 'audio' ? 'A' + (p.audioTrack + 1) : 'V' + (p.videoTrack + 1)) + '\n  Lo que hay ahí:\n' + await describeAround(seq, p.start, ticksPerFrame));
			throw new Error(tag + ': no encuentro ' + clip.name + ' recién puesto. Frené acá; el original está intacto.');
		}
		if (Math.abs((await ticksOf(main.ti.getEndTime())) - p.end) > tol) {
			throw new Error(tag + ': ' + clip.name + ' quedó con otra duración. Frené acá; el original está intacto.');
		}
		if (M.angles && p.kind !== 'audio' && p.match.cameraIndex !== null) {
			camEntries.push({ camera: p.match.cameraIndex + 1, trackIndex: main.trackIndex, start: p.start, end: p.end });
		}
		log('  ' + tag + '  ' + clip.name + (p.kind !== 'video' ? '  A' + (p.audioTrack + 1) + '-A' + (p.audioTrack + p.audioTracks) : '  V' + (p.videoTrack + 1)) + '  ok');
		done++;
		setProgress(done / result.placements.length);
		} catch (e) {
			const msg = e && e.message ? e.message : String(e);
			if (msg.indexOf(tag) === 0) { throw e; }
			throw new Error(tag + ' (' + (p.match.mcName || '') + '): ' + msg + ' Frené acá; el original está intacto.');
		}
	}

	// 5) Control final: cada corte tiene que seguir en su lugar y completo.
	for (const p of result.placements) {
		const at = await itemsAt(seq, p.start, tol);
		const here = { video: at.filter((x) => x.kind === 'video'), audio: at.filter((x) => x.kind === 'audio') };
		const okClip = async (x) => Math.abs((await ticksOf(x.ti.getEndTime())) - p.end) <= tol;
		if (p.kind !== 'audio') {
			const v = here.video.find((x) => x.trackIndex === p.videoTrack);
			if (!v || !(await okClip(v))) { broken.push('#' + p.id + ' imagen'); }
		}
		if (p.kind !== 'video') {
			for (let k = 0; k < p.audioTracks; k++) {
				const a = here.audio.find((x) => x.trackIndex === p.audioTrack + k);
				if (!a || !(await okClip(a))) { broken.push('#' + p.id + ' sonido A' + (p.audioTrack + k + 1)); break; }
			}
		}
	}
	} finally {
		// Los in/out de las multicams, merged y master clips usados quedan como estaban.
		Object.keys(usedTargets).forEach((k) => restoreMarks(project, usedTargets[k].clip, usedTargets[k].mark));
	}
	if (broken.length) {
		log('\nCONTROL FINAL: faltan o están incompletos: ' + broken.join(', '));
		throw new Error('El control final encontró cortes que no quedaron bien (' + broken.join(', ') + '). Revisá la copia; el original está intacto.');
	}
	log('\nControl final: todos los cortes en su lugar y completos.');

	saveState({ seqName: seq.name, mode: m, entries: camEntries });
	analyzedSeqName = seq.name;
	analyzedMode = m;
	refreshSteps();
	const groupsDone = new Set(result.placements.map((p) => p.group)).size;
	log('\nListo: ' + groupsDone + ' cortes en "' + seq.name + '".');

	const missing = result.problems.length + result.skipped.length;
	const verb = m === 'flatten' ? 'con flatten' : 'reconformados';
	setStatus('Listo: ' + groupsDone + ' cortes ' + verb + ' en «' + escapeHtml(seq.name) + '».' +
		(missing ? ' ' + missing + ' quedaron como estaban (en rojo).' : '') +
		(result.warnings.length ? ' Hay ' + result.warnings.length + ' para revisar en el detalle técnico.' : '') +
		(extraTracks ? '<br><span class="muted">En algún corte no había lugar libre para la parte que sobra y quedaron tracks vacíos al final. Se borran con clic derecho en el encabezado de un track → Delete Tracks → All Empty Tracks.</span>' : '') +
		(M.angles ? '<br><span class="muted">Si alguna multicam no muestra ángulos: seleccionala → clic derecho → Multi-Camera → Enable.</span>' : ''), 'ok');
}

// Si la secuencia no es para este modo, decir cuál conviene.
function modeHint(result, m) {
	const n = (re) => result.skipped.filter((x) => re.test(x.reason)).length;
	const merged = n(/merged clip$/) , master = n(/^no es un merged clip$/);
	if ((m === 'mc' || m === 'merged') && merged && merged >= result.placements.length) {
		return 'Esta secuencia está editada con merged clips: elegí <b>Merged → Multicam</b> o <b>Flatten Merged</b>.';
	}
	if ((m === 'mergedmc' || m === 'flatten') && master && !result.placements.length) {
		return 'Esta secuencia está editada con master clips: elegí <b>Master clip → Multicam</b> o <b>Master clip → Merged</b>.';
	}
	return '';
}

/* ---------------- ángulos: seleccionar los cortes de cada cámara ---------------- */

async function selectCamera(n) {
	const project = await ppro.Project.getActiveProject();
	const seq = await project.getActiveSequence();
	if (!seq || !state) { throw new Error('Abrí la copia reconformada.'); }
	const ticksPerFrame = Number(await seq.getTimebase());
	const targets = state.entries.filter((e) => e.camera === n);
	const items = [];
	for (const e of targets) {
		for (const ti of await getTrackItems(await seq.getVideoTrack(e.trackIndex))) {
			if (Math.abs((await ticksOf(ti.getStartTime())) - e.start) <= ticksPerFrame / 2) { items.push(ti); break; }
		}
	}
	project.lockedAccess(() => {
		ppro.TrackItemSelection.createEmptySelection((sel) => {
			items.forEach((ti) => sel.addItem(ti, true));
			seq.setSelection(sel);
		});
	});
	setStatus('Seleccionados ' + items.length + ' cortes de la cámara ' + n + '. Clic derecho sobre uno → Multi-Camera → cámara ' + n + '.', 'ok');
}

async function goTo(ticks) {
	const project = await ppro.Project.getActiveProject();
	const seq = await project.getActiveSequence();
	if (seq) { await safe(() => seq.setPlayerPosition(tt(ticks)), null); }
}

/* ---------------- dibujo del resultado ---------------- */

function renderResult(analysis) {
	const { result, ticksPerFrame, seqEnd } = analysis;
	const m = analysis.mode;
	const fps = Math.round(Core.TICKS_PER_SECOND / ticksPerFrame);
	const tc = (t) => Core.ticksToTC(t, ticksPerFrame, fps);
	const label = result.label || 'multicam';

	// Una fila por reemplazo, en orden de timeline.
	const rows = [];
	result.placements.forEach((p) => {
		const r = { start: p.start, end: p.end, name: p.group.name, mc: p.match.mcName };
		if (m === 'flatten') { r.kind = 'tgt'; r.color = p.kind === 'video' ? VIDEO_COLOR : SOUND_COLOR; r.tag = p.kind === 'video' ? 'Imagen' : 'Sonido'; }
		else if (m === 'merged') { r.kind = p.kind === 'audio' ? 'audio' : 'tgt'; r.color = MERGED_COLOR; r.tag = p.kind === 'audio' ? 'Sonido' : 'Merged'; }
		else { r.kind = p.kind === 'audio' ? 'audio' : 'cam'; r.camera = p.match.cameraIndex !== null ? p.match.cameraIndex + 1 : null; }
		rows.push(r);
	});
	result.problems.forEach((pr) => rows.push({
		start: pr.group.start, end: pr.group.end, kind: 'miss', name: pr.group.name, why: Core.problemReason(pr.match, label)
	}));
	result.skipped.forEach((s) => rows.push({
		start: s.item.start, end: s.item.end, kind: 'skip', name: s.item.name, why: s.reason
	}));
	rows.sort((a, b) => a.start - b.start);

	// Mapa: segmentos proporcionales a la duración, con huecos donde no hay cortes.
	const total = Math.max(seqEnd, rows.length ? rows[rows.length - 1].end : 0) || 1;
	els.map.innerHTML = '';
	let cursor = 0;
	const seen = {};
	rows.forEach((r) => {
		const key = r.start + '-' + r.end;
		if (seen[key] || r.start < cursor) { return; }   // video y audio del mismo corte: un solo segmento
		seen[key] = true;
		if (r.start > cursor) { addSeg(r.start - cursor, 'gap'); }
		const seg = addSeg(r.end - r.start, r.kind === 'cam' || r.kind === 'tgt' ? '' : r.kind);
		if (r.kind === 'cam') { seg.style.backgroundColor = r.camera ? camColor(r.camera) : '#6f6f6f'; }
		if (r.kind === 'tgt') { seg.style.backgroundColor = r.color; }
		seg.title = tc(r.start) + '  ' + r.name;
		seg.addEventListener('click', () => goTo(r.start));
		cursor = r.end;
	});
	function addSeg(len, cls) {
		const d = document.createElement('div');
		d.className = 'seg' + (cls ? ' ' + cls : '');
		d.style.width = (100 * len / total) + '%';
		els.map.appendChild(d);
		return d;
	}

	// Resumen
	const cuts = new Set(result.placements.map((p) => p.group)).size;
	const targets = Object.keys(result.placements.reduce((acc, p) => { acc[p.match.mcKey] = 1; return acc; }, {})).length;
	const plural = { multicam: 'multicams', 'merged clip': 'merged clips', archivo: 'archivos' };
	const stat = (n, text) => '<div class="item"><b>' + n + '</b><span class="muted">' + text + '</span></div>';
	els.stats.innerHTML =
		stat(cuts, cuts === 1 ? 'corte' : 'cortes') +
		stat(targets, targets === 1 ? label : (plural[label] || label)) +
		(result.problems.length + result.skipped.length
			? stat(result.problems.length + result.skipped.length, 'sin reemplazar')
			: '') +
		(result.warnings.length ? stat(result.warnings.length, 'para revisar') : '');

	// Lista
	els.list.innerHTML = '';
	rows.forEach((r) => {
		const row = document.createElement('div');
		row.className = 'row' + (r.kind === 'miss' || r.kind === 'skip' ? ' miss' : '');
		let tag = '';
		if (r.kind === 'cam') { tag = r.camera ? '<span class="swatch" style="background-color:' + camColor(r.camera) + '"></span>Cám ' + r.camera : ''; }
		else if (r.kind === 'tgt') { tag = '<span class="swatch" style="background-color:' + r.color + '"></span>' + r.tag; }
		else if (r.kind === 'audio') { tag = r.tag || 'Sonido'; }
		const what = r.kind === 'miss' || r.kind === 'skip'
			? escapeHtml(r.name) + ' — ' + escapeHtml(r.why)
			: escapeHtml(r.name) + '<br><span class="mc">' + escapeHtml(r.mc) + '</span>';
		row.innerHTML = '<span class="tc muted">' + tc(r.start) + '</span><span class="what">' + what + '</span><span class="cam">' + tag + '</span>';
		row.addEventListener('click', () => goTo(r.start));
		els.list.appendChild(row);
	});

	show(els.result, true);
}

function renderCameras(visible) {
	els.cams.innerHTML = '';
	if (!visible) { return; }
	const cams = Array.from(new Set(state.entries.map((e) => e.camera))).sort((x, y) => x - y);
	cams.forEach((n) => {
		const b = document.createElement('sp-action-button');
		b.setAttribute('size', 's');
		const count = state.entries.filter((e) => e.camera === n).length;
		b.innerHTML = '<span class="swatch" style="background-color:' + camColor(n) + '"></span>Cámara ' + n + ' · ' + count + (count === 1 ? ' corte' : ' cortes');
		b.addEventListener('click', () => guard(() => selectCamera(n)));
		els.cams.appendChild(b);
	});
}

/* ---------------- botones ---------------- */

async function guard(fn) {
	setBusy(true);
	try { await fn(); }
	catch (e) {
		const msg = e && e.message ? e.message : String(e);
		log('\nERROR: ' + msg);
		setStatus(escapeHtml(msg.split('\n')[0]) + '<br><span class="muted">El detalle técnico está en "Ver detalle técnico".</span>', 'error');
	}
	setBusy(false);
}

async function analyzeOnly(m) {
	const M = MODES[m];
	const project = await ppro.Project.getActiveProject();
	const src = await project.getActiveSequence();
	if (!src) { throw new Error('Abrí la secuencia editada en la timeline.'); }
	const srcName = src.name;
	setStatus('Analizando «' + escapeHtml(srcName) + '»…', 'work');
	log('ReconformMC ' + VERSION + ' — ' + M.label + '\nAnalizando "' + srcName + '"…');
	let analysis;
	// Analizar solo lee: no crea secuencias ni cambia nada.
	analysis = await analyzeSequence(project, src, m);
	log('\n' + Core.report(analysis.result, analysis.ticksPerFrame));
	renderResult(analysis);
	analyzedSeqName = srcName;
	analyzedMode = m;
	refreshSteps();
	const r = analysis.result;
	const cuts = new Set(r.placements.map((p) => p.group)).size;
	const missing = r.problems.length + r.skipped.length;
	const verb = m === 'flatten' ? 'listos para el flatten' : 'listos para reconformar';
	setStatus(cuts
		? cuts + ' cortes ' + verb + '.' + (missing ? ' ' + missing + ' van a quedar como están (en rojo).' : '') +
		  (r.warnings.length ? ' ' + r.warnings.length + ' para revisar (en el detalle técnico).' : '') +
		  '<br><span class="muted">No se cambió nada.</span>'
		: (modeHint(r, m) || (m === 'flatten' || m === 'mergedmc' ? 'No encontré merged clips para procesar en esta secuencia.' : 'No encontré cortes para reconformar en esta secuencia.')),
		cuts ? 'ok' : 'error');
}

els.btnAnalyze.addEventListener('click', () => guard(async () => {
	clearLog();
	await analyzeOnly(mode);
}));

els.btnRun.addEventListener('click', () => guard(async () => {
	clearLog();
	await reconform(mode);
}));

els.btnLog.addEventListener('click', () => {
	const open = !els.log.classList.contains('open');
	if (open) { els.log.classList.add('open'); } else { els.log.classList.remove('open'); }
	els.btnLog.textContent = open ? 'Ocultar detalle técnico' : 'Ver detalle técnico';
});

modeButtons().forEach((b) => b.addEventListener('click', () => {
	if (b.hasAttribute('disabled')) { return; }
	setMode(b.getAttribute('data-mode'));
}));

// La secuencia activa se sigue sola: si cambiás de secuencia en la timeline, el panel se actualiza.
setMode(mode);
pollActiveSequence();
setInterval(() => { pollActiveSequence(); }, 1500);
