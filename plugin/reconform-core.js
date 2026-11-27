/*
 * ReconformMC - motor de matcheo (compartido por la versión UXP y la ExtendScript)
 *
 * v2: además de multicams, sabe leer merged clips (por XML), reconformar a merged,
 * reconformar de merged a multicam y hacer flatten de merged.
 *
 * Escrito en JavaScript "viejo" (ES3) a propósito, para que corra igual en
 * ExtendScript (Premiere anterior a 25.6) y en UXP (Premiere 25.6 en adelante).
 * No toca Premiere: recibe datos planos y devuelve un plan.
 *
 * Todos los tiempos están en ticks de Premiere (254016000000 ticks por segundo).
 *
 * Modelo de datos que reciben las funciones:
 *
 *   Multicam (lo arma el adaptador leyendo cada Multicamera Source Sequence del bin):
 *     { key, name,
 *       cameras:   [ { cameraIndex (0 = cámara 1), mediaPath, name, start, end, inPoint, outPoint } ],
 *       audioOnly: [ { mediaPath, name, start, end, inPoint, outPoint } ] }
 *     start/end   = posición del clip dentro de la secuencia multicam
 *     inPoint/out = rango usado del archivo (relativo al inicio del archivo)
 *     tc          = timecode de origen del archivo, en ticks (null si no se pudo leer)
 *
 *   El matcheo es por el ARCHIVO: su nombre sin extensión (source name) y su timecode.
 *   Así un .mp4 de la edición encuentra el .mov o .mxf de la multicam, aunque estén en
 *   otra carpeta o arranquen en otro punto.
 *
 *   Clip de la edición (uno por cada track item de video o de audio):
 *     { kind: 'video'|'audio', trackIndex, start, end, inPoint, outPoint,
 *       mediaPath, name, speed, disabled, skipReason, ref }
 */
var ReconformCore = (function () {
    var TICKS_PER_SECOND = 254016000000;

    function normPath(p) {
        if (!p) { return ''; }
        p = String(p);
        p = p.replace(/^file:\/\/localhost\//i, '').replace(/^file:\/\//i, '');
        try { p = decodeURIComponent(p); } catch (e) { /* la ruta ya venía sin codificar */ }
        p = p.replace(/\\/g, '/').replace(/^\/+/, '');
        return p.toLowerCase();
    }

    function baseName(p) {
        var n = normPath(p);
        var i = n.lastIndexOf('/');
        return i >= 0 ? n.substring(i + 1) : n;
    }

    // Source name: nombre del archivo sin carpeta ni extensión.
    function sourceName(p) {
        var b = baseName(p);
        var m = b.match(/^(.*)\.([a-z0-9]{1,5})$/);
        return m ? m[1] : b;
    }

    // Timecode "hh:mm:ss:ff" (o ;ff para drop frame) a ticks, para una cadencia dada.
    function tcToTicks(str, fps) {
        var m = String(str).match(/(\d+)[:;](\d+)[:;](\d+)([:;.])(\d+)/), nominal, frames, drop, mins;
        if (!m || !fps) { return null; }
        nominal = Math.round(fps);
        frames = ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * nominal + +m[5];
        if (m[4] === ';' && (nominal === 30 || nominal === 60)) {
            drop = nominal === 30 ? 2 : 4;
            mins = +m[1] * 60 + +m[2];
            frames -= drop * (mins - Math.floor(mins / 10));
        }
        return Math.round(frames * TICKS_PER_SECOND / fps);
    }

    // Timecode de origen desde los metadatos XMP del archivo (xmpDM:startTimeCode).
    var TC_FORMATS = {
        '23976timecode': 24000 / 1001, '24timecode': 24, '25timecode': 25,
        '2997droptimecode': 30000 / 1001, '2997nondroptimecode': 30000 / 1001, '30timecode': 30,
        '50timecode': 50, '5994droptimecode': 60000 / 1001, '5994nondroptimecode': 60000 / 1001, '60timecode': 60
    };
    function parseXmpStartTimecode(xmp) {
        if (!xmp) { return null; }
        var block = String(xmp).match(/<xmpDM:startTimeCode([\s\S]*?)(\/>|<\/xmpDM:startTimeCode>)/);
        if (!block) { return null; }
        var b = block[1];
        var fmt = b.match(/timeFormat(?:="|>)([^"<]+)/), val = b.match(/timeValue(?:="|>)([^"<]+)/);
        if (!fmt || !val) { return null; }
        var fps = TC_FORMATS[fmt[1].toLowerCase()];
        return fps ? tcToTicks(val[1], fps) : null;
    }

    function near(a, b, tol) { return Math.abs(a - b) <= tol; }

    function pushTo(dict, key, value) {
        if (!key) { return; }
        if (!dict.hasOwnProperty(key)) { dict[key] = []; }
        dict[key].push(value);
    }

    /* ---------- 1. Índice de multicams ---------- */
    function buildIndex(multicams) {
        var index = { bySource: {}, count: 0, multicams: multicams };
        var m, c, entry, list, j, isCam;
        for (m = 0; m < multicams.length; m++) {
            for (isCam = 1; isCam >= 0; isCam--) {
                list = isCam ? (multicams[m].cameras || []) : (multicams[m].audioOnly || []);
                for (j = 0; j < list.length; j++) {
                    c = list[j];
                    entry = {
                        mc: multicams[m],
                        cameraIndex: isCam ? c.cameraIndex : null,
                        path: normPath(c.mediaPath),
                        source: sourceName(c.mediaPath || c.name),
                        tc: typeof c.tc === 'number' ? c.tc : null,
                        name: c.name,
                        start: c.start, end: c.end, inPoint: c.inPoint, outPoint: c.outPoint
                    };
                    pushTo(index.bySource, entry.source, entry);
                    index.count++;
                }
            }
        }
        return index;
    }

    /* ---------- 2. Matcheo de un tramo de archivo contra el índice ----------
     * Busca los archivos de las multicams con el mismo source name. Si los dos tienen
     * timecode, compara en timecode absoluto (inicio del archivo + in); si no, en tiempo
     * relativo al comienzo del archivo.
     */
    function matchRange(mediaPath, name, inPoint, outPoint, index, tol, tc) {
        var src = sourceName(mediaPath || name);
        var cands = index.bySource[src];
        if (!cands || !cands.length) {
            return { status: 'notfound', matchedBy: null };
        }
        var hasTc = typeof tc === 'number';
        var full = [], partial = [], i, c, useTc, aIn, aOut, cIn, cOut, path = normPath(mediaPath);
        for (i = 0; i < cands.length; i++) {
            c = cands[i];
            useTc = hasTc && c.tc !== null;
            aIn = useTc ? tc + inPoint : inPoint;
            aOut = useTc ? tc + outPoint : outPoint;
            cIn = useTc ? c.tc + c.inPoint : c.inPoint;
            cOut = useTc ? c.tc + c.outPoint : c.outPoint;
            c._useTc = useTc;
            // offset: tiempo en la multicam = tiempo absoluto del archivo + offset
            c._offset = c.start - cIn;
            c._aIn = aIn; c._aOut = aOut;
            if (cIn - tol <= aIn && aOut <= cOut + tol) { full.push(c); }
            else if (aIn < cOut && aOut > cIn) { partial.push(c); }
        }
        // Preferimos: el mismo archivo (misma ruta), después una cámara antes que un audio suelto.
        function pick(list) {
            var k;
            for (k = 0; k < list.length; k++) { if (list[k].path === path && list[k].cameraIndex !== null) { return list[k]; } }
            for (k = 0; k < list.length; k++) { if (list[k].cameraIndex !== null) { return list[k]; } }
            return list[0];
        }
        var chosen, status;
        if (full.length) {
            chosen = pick(full);
            status = 'ok';
            var mcs = {}, distinct = 0;
            for (i = 0; i < full.length; i++) {
                if (!mcs.hasOwnProperty(full[i].mc.key)) { mcs[full[i].mc.key] = 1; distinct++; }
            }
            if (distinct > 1) { status = 'ambiguous'; }
        } else if (partial.length) {
            chosen = pick(partial);
            status = 'partial';
        } else {
            return { status: 'outofrange', matchedBy: 'nombre', candidate: cands[0] };
        }
        return {
            status: status,
            matchedBy: chosen._useTc ? 'nombre y timecode' : 'nombre',
            mcKey: chosen.mc.key,
            mcName: chosen.mc.name,
            mc: chosen.mc,
            cameraIndex: chosen.cameraIndex,
            mcIn: chosen._aIn + chosen._offset,
            mcOut: chosen._aOut + chosen._offset
        };
    }

    /* ---------- 3. Agrupar video + audio del mismo corte ---------- */
    // Un mismo corte puede venir en 1 clip de video + N clips de audio (mono, estéreo,
    // multicanal: da igual). Se agrupan por archivo + posición + rango usado.
    // Los items de un merged clip traen groupKey (el merged), porque su video y su audio
    // vienen de archivos distintos pero son el mismo corte.
    function groupEditItems(items, tol) {
        var groups = [], i, g, it, k, found, key;
        for (i = 0; i < items.length; i++) {
            it = items[i];
            key = it.groupKey || normPath(it.mediaPath);
            found = null;
            for (k = 0; k < groups.length; k++) {
                g = groups[k];
                if (g.path === key && near(g.start, it.start, tol) &&
                    near(g.end, it.end, tol) && (it.mergedKey || near(g.inPoint, it.inPoint, tol))) {
                    found = g; break;
                }
            }
            if (!found) {
                found = { path: key, mediaPath: it.mediaPath, name: it.name, displayName: it.name,
                          mergedKey: it.mergedKey || null,
                          tc: typeof it.tc === 'number' ? it.tc : null,
                          start: it.start, end: it.end, inPoint: it.inPoint, outPoint: it.outPoint,
                          video: [], audio: [] };
                groups.push(found);
            }
            (it.kind === 'video' ? found.video : found.audio).push(it);
        }
        groups.sort(function (a, b) { return a.start - b.start; });
        return groups;
    }

    function span(list) {
        var lo = null, hi = null, i;
        for (i = 0; i < list.length; i++) {
            if (lo === null || list[i].trackIndex < lo) { lo = list[i].trackIndex; }
            if (hi === null || list[i].trackIndex > hi) { hi = list[i].trackIndex; }
        }
        return lo === null ? 0 : hi - lo + 1;
    }

    function minTrack(list) {
        var m = null, i;
        for (i = 0; i < list.length; i++) {
            if (m === null || list[i].trackIndex < m) { m = list[i].trackIndex; }
        }
        return m;
    }

    /* ---------- 4. Reparto de tracks de audio: el mismo damero, más ancho ----------
     * Cada track de audio original es un "carril". Si un sonido ocupaba los carriles
     * t..t+k-1 (k = sus canales originales) y su multicam trae W canales, esos carriles
     * se ensanchan hasta sumar W. Después cada carril se corre hacia abajo lo que se
     * ensancharon los de arriba. Se conserva el orden y el escalonado de la edición, y
     * como en el original nada se superponía, en el resultado tampoco.
     * 'fixed' son los sonidos que quedan como estaban: no se ensanchan, pero se corren
     * junto con su carril (devuelve a qué track va cada uno).
     */
    function allocateAudioTracks(placements, fixed, tol) {
        var i, k, p, t, need, have, h = [], maxTrack = -1, sounds = [];
        for (i = 0; i < placements.length; i++) {
            p = placements[i];
            if (p.kind === 'video') { continue; }
            sounds.push(p);
            if (p.audioTrack + p.audioSpan - 1 > maxTrack) { maxTrack = p.audioTrack + p.audioSpan - 1; }
        }
        for (i = 0; i < fixed.length; i++) { if (fixed[i].trackIndex > maxTrack) { maxTrack = fixed[i].trackIndex; } }
        for (t = 0; t <= maxTrack; t++) { h.push(1); }

        sounds.sort(function (x, y) { return x.audioTrack - y.audioTrack; });

        // Angostar: si el destino trae menos canales que el original, se sacan los carriles
        // que sobran (de abajo hacia arriba), siempre que todos los sonidos que pasan por ese
        // carril sigan entrando y no haya ahí ningún sonido que queda como estaba.
        var fixedLane = {}, cover, ok2, sum, s;
        for (i = 0; i < fixed.length; i++) { fixedLane[fixed[i].trackIndex] = true; }
        for (t = maxTrack; t >= 0; t--) {
            if (fixedLane[t]) { continue; }
            cover = 0; ok2 = true;
            for (i = 0; i < sounds.length && ok2; i++) {
                s = sounds[i];
                if (t < s.audioTrack || t >= s.audioTrack + s.audioSpan) { continue; }
                cover++;
                sum = 0;
                for (k = 0; k < s.audioSpan; k++) { sum += h[s.audioTrack + k]; }
                if (sum - h[t] < s.audioTracks) { ok2 = false; }
            }
            if (cover && ok2) { h[t] = 0; }
        }

        // Ensanchar: si trae más, el último carril del sonido se agranda.
        for (i = 0; i < sounds.length; i++) {
            p = sounds[i];
            have = 0;
            for (k = 0; k < p.audioSpan; k++) { have += h[p.audioTrack + k]; }
            need = p.audioTracks - have;
            if (need > 0) { h[p.audioTrack + p.audioSpan - 1] += need; }
        }
        var newStart = [], acc = 0;
        for (t = 0; t <= maxTrack; t++) { newStart.push(acc); acc += h[t]; }

        for (i = 0; i < sounds.length; i++) { sounds[i].originalAudioTrack = sounds[i].audioTrack; sounds[i].audioTrack = newStart[sounds[i].audioTrack]; }
        var moves = [];
        for (i = 0; i < fixed.length; i++) {
            if (newStart[fixed[i].trackIndex] !== fixed[i].trackIndex) {
                moves.push({ item: fixed[i], from: fixed[i].trackIndex, to: newStart[fixed[i].trackIndex] });
            }
        }
        var used = 0;
        for (i = 0; i < sounds.length; i++) { if (sounds[i].audioTrack + sounds[i].audioTracks > used) { used = sounds[i].audioTrack + sounds[i].audioTracks; } }
        for (i = 0; i < fixed.length; i++) { if (newStart[fixed[i].trackIndex] + 1 > used) { used = newStart[fixed[i].trackIndex] + 1; } }
        return { used: used, moves: moves };
    }

    /* ---------- 4b. Dónde descartar la parte que sobra ----------
     * En un corte solo de imagen, Premiere igual trae el sonido de la multicam (y en uno
     * solo de sonido, la imagen). Esa parte se pone en tracks libres en ese tramo y se
     * borra enseguida, sin agregar tracks:
     *  - Los cortes solo de sonido se ponen primero, cuando todavía no hay ninguna imagen
     *    nueva: su imagen sobrante solo tiene que esquivar las imágenes que quedan como estaban.
     *  - Los cortes solo de imagen descartan su sonido en tracks que, en ese tramo, quedan
     *    libres en el resultado final.
     */
    function planDiscards(placements, fixedAudio, fixedVideo, moves, tol) {
        var i, j, p, t, k, ok, occA = [], occV = [];
        function movedTo(it) {
            for (var q = 0; q < moves.length; q++) { if (moves[q].item === it) { return moves[q].to; } }
            return it.trackIndex;
        }
        for (i = 0; i < fixedAudio.length; i++) { occA.push({ track: movedTo(fixedAudio[i]), start: fixedAudio[i].start, end: fixedAudio[i].end }); }
        for (i = 0; i < fixedVideo.length; i++) { occV.push({ track: fixedVideo[i].trackIndex, start: fixedVideo[i].start, end: fixedVideo[i].end }); }
        for (i = 0; i < placements.length; i++) {
            p = placements[i];
            if (p.kind !== 'video') { for (k = 0; k < p.audioTracks; k++) { occA.push({ track: p.audioTrack + k, start: p.start, end: p.end }); } }
        }
        function busy(occ, track, start, end) {
            for (j = 0; j < occ.length; j++) {
                if (occ[j].track === track && occ[j].start < end - tol && start < occ[j].end - tol) { return true; }
            }
            return false;
        }
        for (i = 0; i < placements.length; i++) {
            p = placements[i];
            if (p.kind === 'video') {
                for (t = 0; ; t++) {
                    ok = true;
                    for (k = 0; k < p.audioTracks; k++) { if (busy(occA, t + k, p.start, p.end)) { ok = false; break; } }
                    if (ok) { break; }
                }
                p.discardAudioTrack = t;
            } else if (p.kind === 'audio') {
                for (t = 0; busy(occV, t, p.start, p.end); t++) { /* buscar */ }
                p.discardVideoTrack = t;
            }
        }
    }

    /* ---------- 5. Plan completo ---------- */
    function plan(editItems, multicams, opts) {
        opts = opts || {};
        var tol = opts.toleranceTicks || 0;
        var index = buildIndex(multicams);
        var usable = [], skipped = [], i, it;

        for (i = 0; i < editItems.length; i++) {
            it = editItems[i];
            if (it.skipReason) { skipped.push({ item: it, reason: it.skipReason }); continue; }
            if (it.speed && Math.abs(it.speed - 1) > 0.0001) {
                skipped.push({ item: it, reason: 'tiene cambio de velocidad (' + Math.round(it.speed * 100) + '%)' });
                continue;
            }
            usable.push(it);
        }

        var groups = groupEditItems(usable, tol);
        var placements = [], problems = [], warnings = [], g, m, p, a, nDis, res;
        var label = opts.label || 'multicam';
        var mmode = opts.mergedByKey ? detectMergedMode(groups, opts.mergedByKey, tol) : 'file';

        for (i = 0; i < groups.length; i++) {
            g = groups[i];
            // Merged clip en la edición: se busca por el archivo que tiene adentro
            // (el video; si es un corte solo de sonido, el archivo de ese sonido).
            if (g.mergedKey) {
                res = resolveMergedGroup(g, opts.mergedByKey ? opts.mergedByKey[g.mergedKey] : null, tol, mmode);
                if (!res.ok) { problems.push({ group: g, match: { status: res.status } }); continue; }
            }
            m = matchRange(g.mediaPath, g.name, g.inPoint, g.outPoint, index, tol, g.tc);
            if (m.status !== 'ok' && m.status !== 'ambiguous') {
                problems.push({ group: g, match: m });
                continue;
            }
            // Merged con imagen y sonido: el sonido se ubica por su propio archivo (el wav) para que
            // quede donde estaba en la edición. Si no cae en el mismo lugar que la imagen, se ponen
            // por separado: la imagen por el .mov y el sonido por el wav.
            if (g.mergedKey && g.video.length && g.audio.length && g.soundFile) {
                var af = g.soundFile;
                var mA = matchRange(af.mediaPath, g.name, af.inPoint, af.outPoint, index, tol, af.tc);
                if ((mA.status === 'ok' || mA.status === 'ambiguous') &&
                    (mA.mcKey !== m.mcKey || Math.abs(mA.mcIn - m.mcIn) > tol)) {
                    placements.push({ id: placements.length + 1, group: g, match: m, kind: 'video', start: g.start, end: g.end,
                        videoTrack: minTrack(g.video), audioTrack: minTrack(g.audio), audioSpan: span(g.audio),
                        audioTracks: m.mc.audioTrackCount || Math.max(g.audio.length, 2), quiet: true, split: true });
                    placements.push({ id: placements.length + 1, group: g, match: mA, kind: 'audio', start: g.start, end: g.end,
                        videoTrack: minTrack(g.video), audioTrack: minTrack(g.audio), audioSpan: span(g.audio),
                        audioTracks: mA.mc.audioTrackCount || Math.max(g.audio.length, 2), quiet: true, split: true });
                    continue;
                }
            }
            p = {
                id: placements.length + 1,
                group: g,
                match: m,
                kind: g.video.length && g.audio.length ? 'av' : (g.video.length ? 'video' : 'audio'),
                start: g.start,
                end: g.end,
                videoTrack: minTrack(g.video),
                audioTrack: minTrack(g.audio),
                audioSpan: span(g.audio),
                audioTracks: m.mc.audioTrackCount || Math.max(g.audio.length, 2)
            };
            if (m.status === 'ambiguous') {
                warnings.push({ placement: p, text: 'el archivo aparece en más de un ' + label + '; se usó ' + m.mcName });
            }
            if (g.channelMismatch) {
                warnings.push({ placement: p, text: 'el merged tiene ' + g.channelMismatch.expected + ' canales y en la timeline había ' +
                                g.channelMismatch.found + '; revisá el audio de este corte' });
            }
            if (g.audio.length > 1) {
                nDis = 0;
                for (a = 0; a < g.audio.length; a++) { if (g.audio[a].disabled) { nDis++; } }
                if (nDis > 0 && nDis < g.audio.length) {
                    warnings.push({ placement: p, text: 'tenía canales de audio desactivados por separado; revisá el audio de este corte' });
                }
            }
            if (p.kind !== 'av') {
                warnings.push({ placement: p, text: (p.kind === 'video' ? 'corte solo de imagen' : 'corte solo de sonido') +
                                ' (corte desfasado); revisalo' });
            }
            placements.push(p);
        }

        // Repartir los tracks de audio sin superposiciones. Ocupan lugar los sonidos que
        // quedan como estaban: los sin multicam y los salteados.
        var fixed = [], fixedVideo = [], q;
        for (i = 0; i < problems.length; i++) {
            for (q = 0; q < problems[i].group.audio.length; q++) { fixed.push(problems[i].group.audio[q]); }
            for (q = 0; q < problems[i].group.video.length; q++) { fixedVideo.push(problems[i].group.video[q]); }
        }
        for (i = 0; i < skipped.length; i++) {
            if (skipped[i].item.kind === 'audio') { fixed.push(skipped[i].item); } else { fixedVideo.push(skipped[i].item); }
        }
        var lanes = allocateAudioTracks(placements, fixed, tol);
        planDiscards(placements, fixed, fixedVideo, lanes.moves, tol);

        // Agrupar por número de cámara para el paso de selección.
        var cameras = {};
        for (i = 0; i < placements.length; i++) {
            p = placements[i];
            if (p.kind !== 'audio' && p.match.cameraIndex !== null) {
                pushTo(cameras, String(p.match.cameraIndex + 1), p.id);
            }
        }

        return { placements: placements, problems: problems, skipped: skipped,
                 warnings: warnings, cameras: opts.angles === false ? {} : cameras, index: index,
                 label: label, targetCount: multicams.length,
                 audioTracksUsed: lanes.used, fixedMoves: lanes.moves };
    }

    /* ======================================================================
     * MERGED CLIPS
     * Un merged clip es por dentro una secuencia oculta. Se lee con la API (getSequence)
     * o, si no se puede, del proyecto guardado (.prproj, secciones 9b en adelante).
     * Las secciones 8 y 9 (XML de Premiere) quedan de una versión anterior y solo se usan
     * en las pruebas.
     * ====================================================================== */

    /* ---------- 7. XML mínimo (sin depender de DOMParser) ---------- */
    function decodeEntities(s) {
        if (s.indexOf('&') < 0) { return s; }
        return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, function (all, e) {
            if (e === 'lt') { return '<'; }
            if (e === 'gt') { return '>'; }
            if (e === 'amp') { return '&'; }
            if (e === 'quot') { return '"'; }
            if (e === 'apos') { return "'"; }
            if (e.charAt(1) === 'x') { return String.fromCharCode(parseInt(e.substring(2), 16)); }
            return String.fromCharCode(parseInt(e.substring(1), 10));
        });
    }

    function parseXml(s) {
        s = String(s);
        var root = { name: '#root', attrs: {}, children: [], text: '' };
        var stack = [root], i = 0, n = s.length, lt, gt, tag, node, q, selfClose, sp, nm, re, am, top;
        while (i < n) {
            top = stack[stack.length - 1];
            lt = s.indexOf('<', i);
            if (lt < 0) { top.text += decodeEntities(s.substring(i)); break; }
            if (lt > i) { top.text += decodeEntities(s.substring(i, lt)); }
            if (s.substr(lt, 4) === '<!--') { gt = s.indexOf('-->', lt); i = gt < 0 ? n : gt + 3; continue; }
            if (s.substr(lt, 9) === '<![CDATA[') {
                gt = s.indexOf(']]>', lt);
                top.text += s.substring(lt + 9, gt < 0 ? n : gt);
                i = gt < 0 ? n : gt + 3; continue;
            }
            if (s.charAt(lt + 1) === '?' || s.charAt(lt + 1) === '!') {
                gt = s.indexOf('>', lt); i = gt < 0 ? n : gt + 1; continue;
            }
            // fin del tag, salteando '>' dentro de comillas
            gt = lt + 1; q = null;
            while (gt < n) {
                var ch = s.charAt(gt);
                if (q) { if (ch === q) { q = null; } }
                else if (ch === '"' || ch === "'") { q = ch; }
                else if (ch === '>') { break; }
                gt++;
            }
            tag = s.substring(lt + 1, gt);
            i = gt + 1;
            if (tag.charAt(0) === '/') { if (stack.length > 1) { stack.pop(); } continue; }
            selfClose = tag.charAt(tag.length - 1) === '/';
            if (selfClose) { tag = tag.substring(0, tag.length - 1); }
            sp = tag.search(/\s/);
            nm = sp < 0 ? tag : tag.substring(0, sp);
            node = { name: nm, attrs: {}, children: [], text: '' };
            if (sp >= 0) {
                re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
                while ((am = re.exec(tag.substring(sp))) !== null) {
                    node.attrs[am[1]] = decodeEntities(am[3] !== undefined && am[3] !== '' ? am[3] : (am[4] || ''));
                }
            }
            top.children.push(node);
            if (!selfClose) { stack.push(node); }
        }
        return root;
    }

    function xChild(node, name) {
        if (!node) { return null; }
        for (var i = 0; i < node.children.length; i++) { if (node.children[i].name === name) { return node.children[i]; } }
        return null;
    }
    function xChildren(node, name) {
        var out = [], i;
        if (!node) { return out; }
        for (i = 0; i < node.children.length; i++) { if (node.children[i].name === name) { out.push(node.children[i]); } }
        return out;
    }
    function xPath(node, path) {
        var parts = path.split('/'), i;
        for (i = 0; i < parts.length && node; i++) { node = xChild(node, parts[i]); }
        return node;
    }
    function xText(node, path) {
        var x = path ? xPath(node, path) : node;
        return x ? x.text.replace(/^\s+|\s+$/g, '') : null;
    }
    function xNum(node, path) {
        var t = xText(node, path);
        return t === null || t === '' ? null : Number(t);
    }
    function xWalk(node, name, out) {
        for (var i = 0; i < node.children.length; i++) {
            if (node.children[i].name === name) { out.push(node.children[i]); }
            xWalk(node.children[i], name, out);
        }
        return out;
    }

    function rateOf(node) {
        var r = xChild(node, 'rate');
        if (!r) { return null; }
        var tb = xNum(r, 'timebase'), ntsc = (xText(r, 'ntsc') || '').toUpperCase() === 'TRUE';
        if (!tb) { return null; }
        return ntsc ? tb * 1000 / 1001 : tb;
    }

    /* ---------- 8. Leer un XML de Premiere (xmeml): clips de la secuencia principal ---------- */
    function readXmeml(text) {
        var doc = parseXml(text);
        var seq = xPath(doc, 'xmeml/sequence');
        if (!seq) { throw new Error('El XML no tiene una secuencia.'); }
        var fps = rateOf(seq) || 25, tpf = TICKS_PER_SECOND / fps;
        var filesById = {}, all = xWalk(doc, 'file', []), i, f;
        for (i = 0; i < all.length; i++) {
            f = all[i];
            if (f.attrs.id && (xChild(f, 'pathurl') || xChild(f, 'name')) && !filesById[f.attrs.id]) { filesById[f.attrs.id] = f; }
        }
        function fileInfo(node) {
            if (!node) { return null; }
            var full = filesById[node.attrs.id] || node;
            var tcNode = xChild(full, 'timecode'), tcTicks = null, tcFps, frame;
            if (tcNode) {
                tcFps = rateOf(tcNode) || rateOf(full) || fps;
                frame = xNum(tcNode, 'frame');
                if (frame !== null && !isNaN(frame)) { tcTicks = Math.round(frame * TICKS_PER_SECOND / tcFps); }
                else if (xText(tcNode, 'string')) { tcTicks = tcToTicks(xText(tcNode, 'string'), tcFps); }
            }
            var media = xChild(full, 'media');
            return {
                id: full.attrs.id, name: xText(full, 'name') || '', pathurl: xText(full, 'pathurl') || '',
                tc: tcTicks, hasVideo: !!xChild(media, 'video'),
                audioChannels: xChildren(media, 'audio').length
            };
        }
        var seqTc = xChild(seq, 'timecode'), seqTcTicks = 0;
        if (seqTc && xNum(seqTc, 'frame') !== null) { seqTcTicks = Math.round(xNum(seqTc, 'frame') * TICKS_PER_SECOND / (rateOf(seqTc) || fps)); }

        var clips = [], kinds = ['video', 'audio'], k, tracks, t, items, j, ci, st, en, inF, outF, cfps, ctpf, tIn, tOut, src;
        for (k = 0; k < kinds.length; k++) {
            tracks = xChildren(xPath(seq, 'media/' + kinds[k]), 'track');
            for (t = 0; t < tracks.length; t++) {
                items = xChildren(tracks[t], 'clipitem');
                for (j = 0; j < items.length; j++) {
                    ci = items[j];
                    cfps = rateOf(ci) || fps; ctpf = TICKS_PER_SECOND / cfps;
                    st = xNum(ci, 'start'); en = xNum(ci, 'end'); inF = xNum(ci, 'in'); outF = xNum(ci, 'out');
                    if (st === null || en === null) { continue; }
                    // -1 = pegado a una transición: se deduce por la duración usada
                    if (st < 0 && en >= 0 && inF !== null && outF !== null) { st = en - (outF - inF); }
                    if (en < 0 && st >= 0 && inF !== null && outF !== null) { en = st + (outF - inF); }
                    tIn = xNum(ci, 'pproTicksIn'); tOut = xNum(ci, 'pproTicksOut');
                    if (tIn === null) { tIn = Math.round((inF || 0) * ctpf); }
                    if (tOut === null) { tOut = Math.round((outF || 0) * ctpf); }
                    src = xChild(ci, 'sourcetrack');
                    clips.push({
                        kind: kinds[k], track: t, name: xText(ci, 'name') || '',
                        enabled: (xText(ci, 'enabled') || 'TRUE').toUpperCase() !== 'FALSE',
                        start: Math.round(st * tpf), end: Math.round(en * tpf),
                        inPoint: tIn, outPoint: tOut,
                        sourceChannel: src ? xNum(src, 'trackindex') : null,
                        file: fileInfo(xChild(ci, 'file'))
                    });
                }
            }
        }
        return { name: xText(seq, 'name'), fps: fps, tpf: tpf, seqTcTicks: seqTcTicks, clips: clips };
    }

    /* ---------- 9. De la sonda a "destinos merged" ----------
     * probes: [ { key, name, start, end, placed: { video: [{track,start,end,inPoint}], audio: [...] } } ]
     *   start/end = tramo de la copia donde se puso el merged entero.
     *   placed    = los track items del merged que leyó la API (inPoint = tiempo interno del merged).
     * Devuelve un destino por merged con el mismo formato que una multicam:
     *   cameras   = el video (cameraIndex 0), audioOnly = los archivos de sonido,
     *   channels  = cada canal de audio del merged, en orden de track.
     * start/end de cada componente están en el tiempo interno del merged (el que usan
     * sus in/out), así el motor de multicams sirve tal cual.
     */
    function buildMergedTargets(probes, xml, tol) {
        var list = [], byKey = {}, failed = [], offset = 0, cands, ci, i, j, found;
        // Calibración: el tiempo 0 del XML tendría que ser el mismo que el de la API.
        if (probes.length) {
            cands = [0, xml.seqTcTicks, -xml.seqTcTicks];
            for (ci = 0; ci < cands.length; ci++) {
                found = false;
                for (j = 0; j < xml.clips.length; j++) {
                    if (xml.clips[j].name === probes[0].name && near(xml.clips[j].start + cands[ci], probes[0].start, tol * 2 + 1)) { found = true; break; }
                }
                if (found) { offset = cands[ci]; break; }
            }
        }
        for (i = 0; i < probes.length; i++) {
            var pr = probes[i], inside = [], c, x;
            for (j = 0; j < xml.clips.length; j++) {
                c = xml.clips[j];
                x = c.start + offset;
                if (c.file && x >= pr.start - tol && x < pr.end + tol) { inside.push(c); }
            }
            if (!inside.length) { failed.push({ key: pr.key, name: pr.name, reason: 'no apareció en el XML' }); continue; }

            var pv = pr.placed.video.length ? pr.placed.video[0] : null;
            var pa = pr.placed.audio.length ? pr.placed.audio[0] : null;
            // tiempo interno = tiempo en la copia + base
            var baseV = pv ? pv.inPoint - pv.start : null;
            var baseA = pa ? pa.inPoint - pa.start : null;
            var base = baseV !== null ? baseV : baseA;
            if (base === null) { failed.push({ key: pr.key, name: pr.name, reason: 'no se pudo leer en la timeline' }); continue; }
            if (baseA === null) { baseA = base; }
            if (baseV === null) { baseV = base; }

            var tgt = { key: pr.key, name: pr.name, kind: 'merged', cameras: [], audioOnly: [], channels: [],
                        baseV: baseV, baseA: baseA, files: {} };
            var camPaths = {}, seenAudio = {}, comp, key;
            inside.sort(function (a, b) { return a.track - b.track || a.start - b.start; });
            for (j = 0; j < inside.length; j++) {
                c = inside[j];
                x = c.start + offset;
                key = normPath(c.file.pathurl || c.file.name);
                comp = {
                    mediaPath: c.file.pathurl || c.file.name, name: c.file.name, tc: c.file.tc,
                    hasVideo: c.file.hasVideo, audioChannels: c.file.audioChannels,
                    xStart: x, xEnd: c.end + offset, inPoint: c.inPoint, outPoint: c.outPoint,
                    sourceChannel: c.sourceChannel, enabled: c.enabled
                };
                if (!tgt.files[key]) { tgt.files[key] = { mediaPath: comp.mediaPath, name: comp.name, tc: comp.tc, hasVideo: comp.hasVideo, audioChannels: comp.audioChannels }; }
                if (c.kind === 'video') {
                    if (!tgt.cameras.length) {
                        comp.cameraIndex = 0;
                        comp.start = x + base; comp.end = comp.xEnd + base;
                        tgt.cameras.push(comp);
                        camPaths[key] = true;
                    }
                } else {
                    tgt.channels.push(comp);
                }
            }
            for (j = 0; j < tgt.channels.length; j++) {
                comp = tgt.channels[j];
                key = normPath(comp.mediaPath);
                if (camPaths[key] || seenAudio[key]) { continue; }
                seenAudio[key] = true;
                tgt.audioOnly.push({ mediaPath: comp.mediaPath, name: comp.name, tc: comp.tc,
                                     start: comp.xStart + base, end: comp.xEnd + base,
                                     inPoint: comp.inPoint, outPoint: comp.outPoint });
            }
            // Cuántos tracks de audio ocupa este merged al ponerlo en la timeline.
            var lo = null, hi = null;
            for (j = 0; j < pr.placed.audio.length; j++) {
                if (lo === null || pr.placed.audio[j].track < lo) { lo = pr.placed.audio[j].track; }
                if (hi === null || pr.placed.audio[j].track > hi) { hi = pr.placed.audio[j].track; }
            }
            tgt.audioTrackCount = lo === null ? tgt.channels.length : hi - lo + 1;
            list.push(tgt);
            byKey[tgt.key] = tgt;
        }
        return { list: list, byKey: byKey, failed: failed, offset: offset };
    }

    /* ---------- 9b. Merged clips leídos del proyecto guardado (.prproj) ----------
     * Para Premiere 25.6 a 26.1, donde un plugin no puede exportar XML. El .prproj es un XML
     * de objetos que se apuntan entre sí (ObjectRef -> ObjectID, ObjectURef -> ObjectUID):
     *   ClipProjectItem -> MasterClip -> VideoClip / AudioClip -> MediaSource -> Media (archivo)
     * No se asume el anidado exacto: desde el MasterClip del merged se recorren los objetos
     * que apunta y se toman los clips de video y audio más cercanos, con su archivo y su in.
     */
    function indexObjects(text) {
        // Los ObjectID se repiten adentro de otras estructuras: vale el de menor sangría
        // (los objetos de primer nivel del proyecto).
        var re = /<([A-Za-z][\w.]*)\s[^>]*?Object(U?)ID="([^"]+)"/g, m, idx = {}, ls, ind;
        while ((m = re.exec(text)) !== null) {
            ls = text.lastIndexOf('\n', m.index);
            ind = m.index - ls - 1;
            if (!idx.hasOwnProperty(m[3]) || ind < idx[m[3]].ind) { idx[m[3]] = { tag: m[1], pos: m.index, ind: ind }; }
        }
        return idx;
    }
    function elementText(text, pos, tag) {
        var gt = text.indexOf('>', pos);
        if (gt < 0) { return null; }
        if (text.charAt(gt - 1) === '/') { return text.substring(pos, gt + 1); }
        var openRe = new RegExp('<' + tag.replace(/\./g, '\\.') + '[\\s>/]', 'g'), close = '</' + tag + '>';
        var depth = 1, i = gt + 1, nc, mo, g2;
        while (depth > 0) {
            nc = text.indexOf(close, i);
            if (nc < 0) { return null; }
            openRe.lastIndex = i;
            while ((mo = openRe.exec(text)) !== null && mo.index < nc) {
                g2 = text.indexOf('>', mo.index);
                if (text.charAt(g2 - 1) !== '/') { depth++; }
                openRe.lastIndex = g2 + 1;
            }
            depth--;
            i = nc + close.length;
        }
        return text.substring(pos, i);
    }
    function collectRefs(node, out) {
        var k;
        for (k in node.attrs) {
            if (node.attrs.hasOwnProperty(k) && (k === 'ObjectRef' || k === 'ObjectURef')) { out.push(node.attrs[k]); }
        }
        for (k = 0; k < node.children.length; k++) { collectRefs(node.children[k], out); }
        return out;
    }
    function firstText(node, name) {
        var all = xWalk(node, name, []);
        for (var i = 0; i < all.length; i++) { var t = xText(all[i]); if (t) { return t; } }
        return null;
    }

    // wanted: { nombre del merged: true }. Devuelve { nombre: [ { video, audio: [...] } ] }
    function readPrprojMerged(text, wanted) {
        var idx = indexObjects(text), out = {}, cache = {}, k;
        var SKIP = { Sequence: 1, ClipProjectItem: 1, BinProjectItem: 1, RootProjectItem: 1, Project: 1, ProjectSettings: 1,
                     VideoSequenceSource: 1, AudioSequenceSource: 1, Markers: 1, MarkerOwner: 1 };
        function obj(id) {
            if (cache.hasOwnProperty(id)) { return cache[id]; }
            var e = idx[id], node = null, t;
            if (e) { t = elementText(text, e.pos, e.tag); if (t) { node = xChild(parseXml(t), e.tag); } }
            cache[id] = node;
            return node;
        }
        function mediaOf(node, depth) {   // Source -> ... -> Media con su ruta
            if (!node || depth > 4) { return null; }
            if (node.name === 'Media') {
                var path = firstText(node, 'ActualMediaFilePath') || firstText(node, 'FilePath');
                return path ? { path: path, media: node } : null;
            }
            var refs = collectRefs(node, []), i, r;
            for (i = 0; i < refs.length; i++) {
                var o = obj(refs[i]);
                if (o && !SKIP[o.name]) { r = mediaOf(o, depth + 1); if (r) { return r; } }
            }
            return null;
        }
        function clipInfo(node, depth) {
            var clip = xChild(node, 'Clip') || node;
            var src = xChild(clip, 'Source');
            var m = src && (src.attrs.ObjectRef || src.attrs.ObjectURef) ? mediaOf(obj(src.attrs.ObjectRef || src.attrs.ObjectURef), 0) : null;
            if (!m) { return null; }
            var dur = null, srcObj = obj(src.attrs.ObjectRef || src.attrs.ObjectURef);
            if (srcObj) { var od = firstText(srcObj, 'OriginalDuration'); if (od) { dur = Number(od); } }
            var ip = xNum(clip, 'InPoint'), op = xNum(clip, 'OutPoint'), chans = 1, lay = xText(node, 'AudioChannelLayout'), sc;
            if (lay) { try { chans = JSON.parse(lay).length || 1; } catch (e) { chans = 1; } }
            else { sc = xChild(node, 'SecondaryContents'); if (sc && sc.children.length) { chans = sc.children.length; } }
            return { kind: node.name === 'VideoClip' ? 'video' : 'audio', path: m.path, inPoint: ip === null ? 0 : ip,
                     outPoint: op, duration: dur, depth: depth, channels: chans };
        }
        function explore(masterId) {
            var seen = {}, queue = [{ id: masterId, depth: 0 }], clips = [], q, o, refs, i;
            seen[masterId] = true;
            while (queue.length) {
                q = queue.shift();
                o = obj(q.id);
                if (!o || (q.depth > 0 && SKIP[o.name])) { continue; }
                if (o.name === 'VideoClip' || o.name === 'AudioClip') {
                    var ci = clipInfo(o, q.depth);
                    if (ci) { clips.push(ci); }
                    continue;
                }
                if (q.depth >= 6 || o.name === 'Media') { continue; }
                refs = collectRefs(o, []);
                for (i = 0; i < refs.length; i++) {
                    if (!seen[refs[i]]) { seen[refs[i]] = true; queue.push({ id: refs[i], depth: q.depth + 1 }); }
                }
            }
            // Por archivo y tipo, los clips más cercanos al merged (no los de su master clip original).
            var minD = {}, res = { video: null, audio: [] }, key, aOrder = [], aBy = {};
            for (i = 0; i < clips.length; i++) {
                key = clips[i].kind + '|' + normPath(clips[i].path);
                if (!minD.hasOwnProperty(key) || clips[i].depth < minD[key]) { minD[key] = clips[i].depth; }
            }
            for (i = 0; i < clips.length; i++) {
                var c = clips[i];
                key = c.kind + '|' + normPath(c.path);
                if (c.depth !== minD[key]) { continue; }
                if (c.kind === 'video') { if (!res.video) { res.video = c; } continue; }
                if (!aBy[key]) { aBy[key] = { path: c.path, inPoint: c.inPoint, outPoint: c.outPoint, duration: c.duration, channels: 0 }; aOrder.push(key); }
                aBy[key].channels += c.channels;
            }
            for (i = 0; i < aOrder.length; i++) { res.audio.push(aBy[aOrder[i]]); }
            return res;
        }
        var re = /<ClipProjectItem\s[^>]*ObjectUID="([^"]+)"/g, m, node, name, mc;
        while ((m = re.exec(text)) !== null) {
            node = obj(m[1]);
            if (!node) { continue; }
            name = xText(node, 'ProjectItem/Name');
            if (!name || !wanted.hasOwnProperty(name)) { continue; }
            mc = xChild(node, 'MasterClip');
            if (!mc || !(mc.attrs.ObjectURef || mc.attrs.ObjectRef)) { continue; }
            var comp = explore(mc.attrs.ObjectURef || mc.attrs.ObjectRef);
            if (!comp.video && !comp.audio.length) { continue; }
            if (!out[name]) { out[name] = []; }
            out[name].push(comp);
        }
        return out;
    }

    /* entries: [ { key, name, vS, vE, vRef, aS, aE, aRef, video: {path,inPoint,tc}, audio: [{path,inPoint,channels,tc}] } ]
     * vS/vE (aS/aE) = rango completo del merged en su tiempo interno (la API, sin marcas).
     * vRef (aRef)   = instante interno que corresponde al in guardado de cada componente.
     * Archivo en el instante interno t = in del componente + (t - ref). */
    function buildMergedTargetsFromProject(entries) {
        var list = [], byKey = {}, failed = [], i, j, ch, e, t, len, key, camKey, fin;
        for (i = 0; i < entries.length; i++) {
            e = entries[i];
            if (!e.video && !(e.audio && e.audio.length)) { failed.push({ key: e.key, name: e.name, reason: e.reason || 'no está en el proyecto guardado' }); continue; }
            if (e.vS === null) { e.vS = e.aS; e.vE = e.aE; e.vRef = e.aRef; }
            if (e.aS === null) { e.aS = e.vS; e.aE = e.vE; e.aRef = e.vRef; }
            t = { key: e.key, name: e.name, kind: 'merged', cameras: [], audioOnly: [], channels: [], files: {},
                  baseV: e.vS, baseA: e.aS };
            camKey = null;
            if (e.video) {
                len = e.vE - e.vS;
                fin = e.video.inPoint + (e.vS - e.vRef);
                camKey = normPath(e.video.path);
                t.cameras.push({ cameraIndex: 0, mediaPath: e.video.path, name: baseName(e.video.path), tc: e.video.tc,
                                 xStart: 0, xEnd: len, start: e.vS, end: e.vE, inPoint: fin, outPoint: fin + len });
                t.files[camKey] = { mediaPath: e.video.path, name: baseName(e.video.path), tc: e.video.tc, hasVideo: true, audioChannels: 0 };
            }
            len = e.aE - e.aS;
            for (j = 0; j < (e.audio || []).length; j++) {
                var a = e.audio[j];
                key = normPath(a.path);
                fin = a.inPoint + (e.aS - e.aRef);
                for (ch = 0; ch < Math.max(1, a.channels); ch++) {
                    t.channels.push({ mediaPath: a.path, name: baseName(a.path), tc: a.tc, hasVideo: key === camKey,
                                      sourceChannel: ch + 1, xStart: 0, xEnd: len, inPoint: fin, outPoint: fin + len, enabled: true });
                }
                if (t.files[key]) { t.files[key].audioChannels = a.channels; }
                else { t.files[key] = { mediaPath: a.path, name: baseName(a.path), tc: a.tc, hasVideo: false, audioChannels: a.channels }; }
                if (key !== camKey) {
                    t.audioOnly.push({ mediaPath: a.path, name: baseName(a.path), tc: a.tc, start: e.aS, end: e.aE,
                                       inPoint: fin, outPoint: fin + len });
                }
            }
            t.audioTrackCount = t.channels.length;
            list.push(t);
            byKey[t.key] = t;
        }
        return { list: list, byKey: byKey, failed: failed };
    }

    /* ---------- 9c. Merged = secuencia interna (estructura real de Premiere) ----------
     * Un merged clip es por dentro una secuencia oculta, como una Multicamera Source Sequence:
     *   ClipProjectItem -> MasterClip -> Video/AudioClip -> Video/AudioSequenceSource -> Sequence
     *   Sequence -> Video/AudioTrackGroup -> Tracks -> Video/AudioClipTrack -> TrackItems
     *   ClipTrackItem (Start/End) -> SubClip -> Video/AudioClip (InPoint/OutPoint) -> MediaSource -> Media
     * Devuelve, por nombre de merged, lo mismo que se lee con la API de su secuencia:
     *   { video: [ {track, start, end, inPoint, outPoint, mediaPath} ], audio: [...] }
     */
    function readPrprojMergedSeqs(text, wanted, diag) {
        var idx = indexObjects(text), out = {}, cache = {};
        function raw(id) { var e = idx[id]; return e ? elementText(text, e.pos, e.tag) : null; }
        function tag(id) { return idx[id] ? idx[id].tag : null; }
        function obj(id) {
            if (cache.hasOwnProperty(id)) { return cache[id]; }
            var t = raw(id), node = t ? xChild(parseXml(t), tag(id)) : null;
            cache[id] = node;
            return node;
        }
        function refOf(node) { return node ? (node.attrs.ObjectRef || node.attrs.ObjectURef || null) : null; }
        function mediaPathOfSource(srcId) {
            var src = obj(srcId); if (!src) { return null; }
            var mref = refOf(xPath(src, 'MediaSource/Media'));
            var media = mref ? obj(mref) : null;
            return media ? (firstText(media, 'ActualMediaFilePath') || firstText(media, 'FilePath')) : null;
        }
        function sequenceOfMasterClip(mcId) {
            var mc = obj(mcId), clips = xChildren(xChild(mc, 'Clips'), 'Clip'), i, c, src, seqRef;
            for (i = 0; i < clips.length; i++) {
                c = obj(refOf(clips[i]));
                src = c ? obj(refOf(xPath(c, 'Clip/Source'))) : null;
                if (src && /SequenceSource$/.test(src.name)) {
                    seqRef = refOf(xPath(src, 'SequenceSource/Sequence'));
                    if (seqRef) { return seqRef; }
                }
            }
            return null;
        }
        function readItem(id, track) {
            var it = obj(id); if (!it) { return null; }
            var cti = xChild(it, 'ClipTrackItem');
            var st = xNum(cti, 'TrackItem/Start'), en = xNum(cti, 'TrackItem/End');
            var sub = obj(refOf(xChild(cti, 'SubClip')));
            var clip = sub ? obj(refOf(xChild(sub, 'Clip'))) : null;
            if (!clip) { return null; }
            var cl = xChild(clip, 'Clip');
            var path = mediaPathOfSource(refOf(xChild(cl, 'Source')));
            if (!path) { return null; }
            var ip = xNum(cl, 'InPoint') || 0, s0 = st || 0;
            return { track: track, start: s0, end: en, inPoint: ip, outPoint: ip + (en - s0), mediaPath: path };
        }
        function readSequence(seqId) {
            var seq = obj(seqId), res = { video: [], audio: [], skipped: 0 };
            var groups = xChildren(xChild(seq, 'TrackGroups'), 'TrackGroup'), g, gid, gnode, kind, tracks, t, tr, items, k, r;
            for (g = 0; g < groups.length; g++) {
                gid = refOf(xChild(groups[g], 'Second'));
                gnode = gid ? obj(gid) : null;
                if (!gnode) { continue; }
                kind = gnode.name === 'VideoTrackGroup' ? 'video' : gnode.name === 'AudioTrackGroup' ? 'audio' : null;
                if (!kind) { continue; }
                tracks = xChildren(xPath(gnode, 'TrackGroup/Tracks'), 'Track');
                for (t = 0; t < tracks.length; t++) {
                    tr = obj(refOf(tracks[t]));
                    items = xChildren(xPath(tr, 'ClipTrack/ClipItems/TrackItems'), 'TrackItem');
                    for (k = 0; k < items.length; k++) {
                        r = null;
                        try { r = readItem(refOf(items[k]), Number(tracks[t].attrs.Index || t)); } catch (e) { r = null; }
                        if (r) { res[kind].push(r); } else { res.skipped++; }
                    }
                }
            }
            return res;
        }
        // Los nombres se comparan sin importar espacios de más ni la forma de los acentos.
        var want = {}, w;
        for (w in wanted) { if (wanted.hasOwnProperty(w)) { want[normName(w)] = w; } }
        diag = diag || {};
        var re = /<ClipProjectItem\s[^>]*ObjectUID="([^"]+)"/g, m, node, name, key, mcId, seqId;
        while ((m = re.exec(text)) !== null) {
            node = obj(m[1]);
            name = node ? xText(node, 'ProjectItem/Name') : null;
            key = name ? want[normName(name)] : null;
            mcId = node ? refOf(xChild(node, 'MasterClip')) : null;
            // Si no coincide el nombre del bin, se prueba con el del master clip.
            if (!key && mcId) { var mcn = obj(mcId); mcn = mcn ? xText(mcn, 'Name') : null; key = mcn ? want[normName(mcn)] : null; }
            if (!key || out[key]) { continue; }
            seqId = mcId ? sequenceOfMasterClip(mcId) : null;
            if (!seqId) { diag[key] = 'está en el proyecto guardado, pero no encuentro su secuencia interna'; continue; }
            var sq = readSequence(seqId);
            if (sq.video.length || sq.audio.length) { out[key] = sq; delete diag[key]; }
            else { diag[key] = 'está en el proyecto guardado, pero no pude leer sus archivos (' + sq.skipped + ' piezas sin archivo)'; }
        }
        return out;
    }
    function normName(s) {
        s = String(s || '');
        if (typeof s.normalize === 'function') { try { s = s.normalize('NFC'); } catch (e) { /* ES3 */ } }
        return s.replace(/\s+/g, ' ').replace(/^ | $/g, '');
    }

    // Nombres de los merged clips según el proyecto guardado: secuencias con BE.Sequence.IsMergedClip.
    function readPrprojMergedNames(text) {
        var out = [], re = /<Sequence\s[^>]*ObjectUID="[^"]+"[^>]*>/g, m, pos, end, chunk, nm, seen = {};
        while ((m = re.exec(text)) !== null) {
            pos = m.index;
            end = text.indexOf('</Sequence>', pos);
            if (end < 0) { break; }
            chunk = text.substring(pos, end);
            if (!/<BE\.Sequence\.IsMergedClip>\s*true\s*</.test(chunk)) { continue; }
            nm = chunk.match(/<Name>([^<]*)<\/Name>/);
            if (nm) { nm = decodeEntities(nm[1]); if (!seen[nm]) { seen[nm] = true; out.push(nm); } }
        }
        return out;
    }

    /* entries: [ { key, name, video: [items], audio: [items] } ] con items de la secuencia interna
     * del merged (leídos con la API o del .prproj): {track, start, end, inPoint, outPoint, mediaPath, tc}.
     * Queda un destino con el mismo formato que una multicam (tiempo = el de esa secuencia). */
    function buildMergedTargetsFromSeq(entries) {
        var list = [], byKey = {}, failed = [], i, j, e, t, c, key, camPaths;
        function comp(it, extra) {
            var o = { mediaPath: it.mediaPath, name: baseName(it.mediaPath), tc: typeof it.tc === 'number' ? it.tc : null,
                      start: it.start, end: it.end, xStart: it.start, xEnd: it.end, inPoint: it.inPoint, outPoint: it.outPoint,
                      track: it.track };
            for (var k in extra) { if (extra.hasOwnProperty(k)) { o[k] = extra[k]; } }
            return o;
        }
        for (i = 0; i < entries.length; i++) {
            e = entries[i];
            if (!e.video || (!e.video.length && !(e.audio && e.audio.length))) {
                failed.push({ key: e.key, name: e.name, reason: e.reason || 'no se pudo leer por dentro' }); continue;
            }
            t = { key: e.key, name: e.name, kind: 'merged', cameras: [], audioOnly: [], channels: [], files: {}, baseV: 0, baseA: 0 };
            camPaths = {};
            var vids = e.video.slice().sort(function (a, b) { return a.track - b.track || a.start - b.start; });
            for (j = 0; j < vids.length; j++) {
                t.cameras.push(comp(vids[j], { cameraIndex: 0 }));
                key = normPath(vids[j].mediaPath);
                camPaths[key] = true;
                if (!t.files[key]) { t.files[key] = { mediaPath: vids[j].mediaPath, name: baseName(vids[j].mediaPath), tc: vids[j].tc, hasVideo: true, audioChannels: 0 }; }
            }
            var auds = (e.audio || []).slice().sort(function (a, b) { return a.track - b.track || a.start - b.start; });
            var seenA = {};
            for (j = 0; j < auds.length; j++) {
                key = normPath(auds[j].mediaPath);
                t.channels.push(comp(auds[j], { hasVideo: !!camPaths[key], sourceChannel: j + 1, enabled: true }));
                if (!t.files[key]) { t.files[key] = { mediaPath: auds[j].mediaPath, name: baseName(auds[j].mediaPath), tc: auds[j].tc, hasVideo: false, audioChannels: 0 }; }
                t.files[key].audioChannels++;
                if (!camPaths[key] && !seenA[key]) { seenA[key] = true; t.audioOnly.push(comp(auds[j], {})); }
            }
            t.audioTrackCount = t.channels.length;
            list.push(t);
            byKey[t.key] = t;
        }
        return { list: list, byKey: byKey, failed: failed };
    }

    /* ---------- 10. Un corte de merged en la edición -> los archivos que tiene adentro ----------
     * En la timeline, cada pieza de un merged apunta directo a su archivo (así lo guarda
     * Premiere): el in del video es tiempo del .mov y el del sonido, tiempo del wav ('file').
     * Por las dudas también se contempla que venga en tiempo de la secuencia interna
     * ('internal'): en un corte con imagen y sonido, el desfasaje entre los dos in lo delata.
     */
    function compFor(list, item, k) {
        var i;
        if (!list.length) { return null; }
        if (item.kind === 'video') {
            for (i = 0; i < list.length; i++) { if (item.mediaPath && normPath(list[i].mediaPath) === normPath(item.mediaPath)) { return list[i]; } }
            return list[0];
        }
        return list[Math.min(k, list.length - 1)];
    }
    function fileRange(comp, item, mode, tol) {
        var cs = typeof comp.start === 'number' ? comp.start : (comp.xStart || 0);
        var fin = mode === 'internal' ? comp.inPoint + (item.inPoint - cs) : item.inPoint;
        var fout = fin + (item.outPoint - item.inPoint);
        return { mediaPath: comp.mediaPath, name: comp.name, tc: comp.tc, hasVideo: comp.hasVideo,
                 sourceChannel: comp.sourceChannel, inPoint: fin, outPoint: fout,
                 outside: fin < comp.inPoint - tol || fout > comp.outPoint + tol };
    }
    // Lugar dentro de la secuencia interna del merged que le corresponde a una pieza de la
    // edición si es de ese archivo (el in de la pieza es tiempo del archivo).
    function innerPos(comp, item) {
        var cs = typeof comp.start === 'number' ? comp.start : (comp.xStart || 0);
        return cs + (item.inPoint - comp.inPoint);
    }
    // ¿La pieza puede ser de ese archivo? (cae dentro de lo que ese archivo ocupa en el merged)
    function insideComp(comp, item, tol) {
        var pos = innerPos(comp, item), len = item.outPoint - item.inPoint;
        var cs = typeof comp.start === 'number' ? comp.start : 0, ce = typeof comp.end === 'number' ? comp.end : Infinity;
        return pos >= cs - tol && pos + len <= ce + tol;
    }

    /* Cada pieza de sonido de la edición -> el canal del merged que es.
     * Un merged puede tener sonido de más de un archivo (el wav y el audio de cámara del .mov,
     * cada uno con su TC). Se reconoce de qué archivo es cada pieza:
     *   1) por su archivo, si la pieza lo dice;
     *   2) por su tiempo: todas las piezas de un corte caen en el mismo lugar del merged
     *      (el de la imagen, si la hay), y eso solo pasa con el archivo correcto;
     *   3) si no se puede saber, por el orden de los canales.
     * Dentro de un mismo archivo, los canales van en orden. */
    function assignAudio(g, tgt, audio, mode, tol) {
        var ch = tgt.channels, n = audio.length, out = [], used = {}, i, j;
        if (mode === 'internal') {
            for (i = 0; i < n; i++) { out.push(ch[Math.min(i, ch.length - 1)]); }
            return out;
        }
        var files = {}, nf = 0;
        for (j = 0; j < ch.length; j++) { if (!files[normPath(ch[j].mediaPath)]) { files[normPath(ch[j].mediaPath)] = true; nf++; } }
        if (nf <= 1) {
            for (i = 0; i < n; i++) { out.push(ch[Math.min(i, ch.length - 1)]); }
            return out;
        }
        // Referencia: la imagen; si no hay, el lugar en el que coincidan más piezas.
        var ref = null, cam, best, cnt, cand, a, b;
        if (g.video.length && tgt.cameras.length) {
            cam = compFor(tgt.cameras, g.video[0], 0);
            ref = innerPos(cam, g.video[0]);
        } else {
            // Cuántas piezas entran (cada canal se usa una vez) si el corte está en 'cand';
            // a igualdad, cuántas coinciden con el orden de los canales.
            var score = function (cand) {
                var u = {}, hit = 0, ord = 0, x, y;
                for (x = 0; x < n; x++) {
                    for (y = 0; y < ch.length; y++) {
                        if (!u[y] && insideComp(ch[y], audio[x], tol) && Math.abs(innerPos(ch[y], audio[x]) - cand) <= tol) {
                            u[y] = true; hit++; if (y === x) { ord++; } break;
                        }
                    }
                }
                return hit * 1000 + ord;
            };
            best = -1;
            for (a = 0; a < n; a++) {
                for (j = 0; j < ch.length; j++) {
                    if (!insideComp(ch[j], audio[a], tol)) { continue; }
                    cand = innerPos(ch[j], audio[a]);
                    cnt = score(cand);
                    if (cnt > best) { best = cnt; ref = cand; }
                }
            }
        }
        function free(fileKey) {
            for (var r = 0; r < ch.length; r++) { if (!used[r] && normPath(ch[r].mediaPath) === fileKey) { return r; } }
            return -1;
        }
        for (i = 0; i < n; i++) {
            var it = audio[i], pick = -1, k, fits = [], byPath = [];
            // 1) por tiempo (lo más confiable: la pieza puede informar el archivo del merged)
            if (ref !== null) {
                for (k = 0; k < ch.length; k++) {
                    if (!used[k] && Math.abs(innerPos(ch[k], it) - ref) <= tol) { fits.push(k); }
                }
                // Un corte con imagen corrido respecto del merged (se pasa del borde): se acepta igual.
                if (!fits.length && g.video.length) {
                    for (k = 0; k < ch.length; k++) { if (!used[k] && insideComp(ch[k], it, tol) && Math.abs(innerPos(ch[k], it) - ref) <= tol * 2) { fits.push(k); } }
                }
            }
            // 2) entre los que entran (o todos, si ninguno), el de su archivo
            if (it.mediaPath) {
                var pool = fits.length ? fits : [];
                for (k = 0; k < pool.length; k++) { if (normPath(ch[pool[k]].mediaPath) === normPath(it.mediaPath)) { byPath.push(pool[k]); } }
                if (!fits.length && files[normPath(it.mediaPath)] && ref === null) { pick = free(normPath(it.mediaPath)); }
            }
            if (pick < 0 && (byPath.length || fits.length)) { pick = free(normPath(ch[(byPath.length ? byPath : fits)[0]].mediaPath)); }
            // 2b) entra por tiempo en un canal ya usado (el merged se leyó incompleto): mismo archivo
            if (pick < 0 && ref !== null) {
                for (k = 0; k < ch.length; k++) { if (Math.abs(innerPos(ch[k], it) - ref) <= tol) { pick = k; break; } }
            }
            // 3) por orden
            if (pick < 0) {
                for (k = Math.min(i, ch.length - 1); k < ch.length; k++) { if (!used[k]) { pick = k; break; } }
                if (pick < 0) { for (k = 0; k < ch.length; k++) { if (!used[k]) { pick = k; break; } } }
                if (pick < 0) { pick = Math.min(i, ch.length - 1); }
            }
            used[pick] = true;
            out.push(ch[pick]);
        }
        return out;
    }

    // 'file' o 'internal' para un corte con imagen y sonido; null si no se puede saber.
    // Se mira cada pieza de sonido: en 'file', alguna cae en el lugar de la imagen solo si se
    // la toma como de su propio archivo; en 'internal', todas tienen el mismo in que la imagen.
    function groupMode(g, tgt, tol) {
        if (!g.video.length || !g.audio.length || !tgt || !tgt.cameras.length || !tgt.channels.length) { return null; }
        var cam = compFor(tgt.cameras, g.video[0], 0), ref = innerPos(cam, g.video[0]);
        var camSync = cam.inPoint - (typeof cam.start === 'number' ? cam.start : 0);
        var i, j, ch, sync, fileHits = 0, sameIn = 0, distinct = 0;
        for (j = 0; j < tgt.channels.length; j++) {
            ch = tgt.channels[j];
            sync = (ch.inPoint - (typeof ch.start === 'number' ? ch.start : 0)) - camSync;
            if (Math.abs(sync) > tol * 2) { distinct++; }
        }
        if (!distinct) { return null; }   // todos los archivos con el mismo tiempo: da igual
        for (i = 0; i < g.audio.length; i++) {
            if (Math.abs(g.audio[i].inPoint - g.video[0].inPoint) <= tol) { sameIn++; }
            for (j = 0; j < tgt.channels.length; j++) {
                ch = tgt.channels[j];
                sync = (ch.inPoint - (typeof ch.start === 'number' ? ch.start : 0)) - camSync;
                if (Math.abs(sync) > tol * 2 && Math.abs(innerPos(ch, g.audio[i]) - ref) <= tol) { fileHits++; break; }
            }
        }
        if (fileHits) { return 'file'; }
        if (sameIn === g.audio.length) {
            // Todo con el in de la imagen: o es tiempo interno, o es todo audio de cámara.
            var camCh = 0;
            for (j = 0; j < tgt.channels.length; j++) { if (tgt.channels[j].hasVideo) { camCh++; } }
            return g.audio.length > camCh ? 'internal' : null;
        }
        return null;
    }
    function detectMergedMode(groups, mergedByKey, tol) {
        var f = 0, n = 0, i, md;
        for (i = 0; i < groups.length; i++) {
            if (!groups[i].mergedKey) { continue; }
            md = groupMode(groups[i], mergedByKey ? mergedByKey[groups[i].mergedKey] : null, tol);
            if (md === 'file') { f++; } else if (md === 'internal') { n++; }
        }
        return n > f ? 'internal' : 'file';
    }

    function resolveMergedGroup(g, tgt, tol, mode) {
        if (!tgt) { return { ok: false, status: 'nomerged' }; }
        mode = groupMode(g, tgt, tol) || mode || 'file';
        var i, audio = g.audio.slice().sort(function (a, b) { return a.trackIndex - b.trackIndex; });
        if (g.video.length) {
            if (!tgt.cameras.length) { return { ok: false, status: 'novideo' }; }
            for (i = 0; i < g.video.length; i++) { g.video[i].file = fileRange(compFor(tgt.cameras, g.video[i], 0), g.video[i], mode, tol); }
        }
        if (audio.length) {
            if (!tgt.channels.length) { return { ok: false, status: 'noaudio' }; }
            var chs = assignAudio(g, tgt, audio, mode, tol);
            for (i = 0; i < audio.length; i++) { audio[i].file = fileRange(chs[i], audio[i], mode, tol); }
            g.channelMismatch = audio.length !== tgt.channels.length ? { expected: tgt.channels.length, found: audio.length } : null;
        }
        // Sonido de referencia: el del archivo de sonido (wav), no el de cámara, si lo hay.
        g.soundFile = null;
        for (i = 0; i < audio.length; i++) { if (!audio[i].file.hasVideo) { g.soundFile = audio[i].file; break; } }
        if (!g.soundFile && audio.length) { g.soundFile = audio[0].file; }
        var primary = g.video.length ? g.video[0].file : g.soundFile;
        g.displayName = g.name;
        g.mediaPath = primary.mediaPath;
        g.tc = typeof primary.tc === 'number' ? primary.tc : null;
        g.inPoint = primary.inPoint;
        g.outPoint = primary.outPoint;
        g.audioSorted = audio;
        g.mergedMode = mode;
        return { ok: true };
    }

    /* ---------- 11. Flatten de merged clips ----------
     * Cada corte de merged se reemplaza por sus archivos: el video por su master clip
     * (solo imagen) y cada archivo de sonido por el suyo (solo sonido), en el mismo tramo,
     * con sus in/out reales. clips: { normPath: { key, name, audioTrackCount, hasVideo } }
     * (también se busca por source name, por si el archivo se re-linkeó).
     */
    function planFlatten(editItems, mergedByKey, clips, opts) {
        opts = opts || {};
        var tol = opts.toleranceTicks || 0;
        var bySource = {}, k;
        for (k in clips) { if (clips.hasOwnProperty(k)) { pushTo(bySource, sourceName(clips[k].mediaPath || k), clips[k]); } }
        function findClip(path) {
            var c = clips[normPath(path)];
            if (c) { return c; }
            var s = bySource[sourceName(path)];
            return s && s.length ? s[0] : null;
        }
        var usable = [], skipped = [], i, it;
        for (i = 0; i < editItems.length; i++) {
            it = editItems[i];
            if (it.skipReason) { skipped.push({ item: it, reason: it.skipReason }); continue; }
            if (it.speed && Math.abs(it.speed - 1) > 0.0001) {
                skipped.push({ item: it, reason: 'tiene cambio de velocidad (' + Math.round(it.speed * 100) + '%)' });
                continue;
            }
            usable.push(it);
        }
        var groups = groupEditItems(usable, tol);
        var placements = [], problems = [], warnings = [], g, res, parts, j, sub, byFile, order, f, c, missing;
        var mmode = detectMergedMode(groups, mergedByKey, tol);

        for (i = 0; i < groups.length; i++) {
            g = groups[i];
            res = resolveMergedGroup(g, mergedByKey[g.mergedKey], tol, mmode);
            if (!res.ok) { problems.push({ group: g, match: { status: res.status } }); continue; }
            parts = []; missing = null;
            if (g.video.length) {
                f = g.video[0].file;
                c = findClip(f.mediaPath);
                if (!c) { missing = f.name; }
                else { parts.push({ kind: 'video', clip: c, file: f, items: g.video }); }
            }
            byFile = {}; order = [];
            for (j = 0; j < g.audioSorted.length; j++) {
                f = g.audioSorted[j].file;
                k = normPath(f.mediaPath);
                if (!byFile.hasOwnProperty(k)) { byFile[k] = []; order.push(k); }
                byFile[k].push(g.audioSorted[j]);
            }
            for (j = 0; j < order.length && !missing; j++) {
                sub = byFile[order[j]];
                c = findClip(sub[0].file.mediaPath);
                if (!c) { missing = sub[0].file.name; }
                else { parts.push({ kind: 'audio', clip: c, file: sub[0].file, items: sub }); }
            }
            if (missing) { problems.push({ group: g, match: { status: 'noclip', file: missing } }); continue; }

            for (j = 0; j < parts.length; j++) {
                var pt = parts[j], p;
                p = {
                    id: placements.length + 1, group: g, kind: pt.kind, start: g.start, end: g.end,
                    match: { status: 'ok', matchedBy: 'merged', mcKey: pt.clip.key, mcName: pt.clip.name, mc: pt.clip,
                             cameraIndex: null, mcIn: pt.file.inPoint, mcOut: pt.file.outPoint },
                    videoTrack: pt.kind === 'video' ? minTrack(pt.items) : null,
                    audioTrack: pt.kind === 'audio' ? minTrack(pt.items) : null,
                    audioSpan: pt.kind === 'audio' ? span(pt.items) : 0,
                    audioTracks: pt.clip.audioTrackCount || 0,
                    targetHasVideo: pt.clip.hasVideo !== false,
                    quiet: true
                };
                if (pt.kind === 'audio' && !p.audioTracks) { p.audioTracks = pt.items.length; }
                if (pt.file.outside) {
                    warnings.push({ placement: p, text: pt.file.name + ': el corte se pasa del principio o del final del archivo; revisalo' });
                }
                placements.push(p);
            }
            if (g.channelMismatch && placements.length) {
                warnings.push({ placement: placements[placements.length - 1], text: 'el merged tiene ' + g.channelMismatch.expected +
                                ' canales y en la timeline había ' + g.channelMismatch.found + '; revisá el audio de este corte' });
            }
        }

        var fixed = [], fixedVideo = [], q;
        for (i = 0; i < problems.length; i++) {
            for (q = 0; q < problems[i].group.audio.length; q++) { fixed.push(problems[i].group.audio[q]); }
            for (q = 0; q < problems[i].group.video.length; q++) { fixedVideo.push(problems[i].group.video[q]); }
        }
        for (i = 0; i < skipped.length; i++) {
            if (skipped[i].item.kind === 'audio') { fixed.push(skipped[i].item); } else { fixedVideo.push(skipped[i].item); }
        }
        var lanes = allocateAudioTracks(placements, fixed, tol);
        planDiscards(placements, fixed, fixedVideo, lanes.moves, tol);
        var n = 0, seen = {};
        for (i = 0; i < placements.length; i++) { if (!seen[placements[i].match.mcKey]) { seen[placements[i].match.mcKey] = 1; n++; } }
        return { placements: placements, problems: problems, skipped: skipped, warnings: warnings, cameras: {},
                 index: { multicams: [] }, label: 'archivo', targetCount: n, flatten: true,
                 audioTracksUsed: lanes.used, fixedMoves: lanes.moves };
    }

    /* ---------- 6. Reporte legible ---------- */
    function ticksToTC(ticks, ticksPerFrame, fps) {
        var total = Math.round(ticks / ticksPerFrame);
        var f = total % fps, s = Math.floor(total / fps);
        function pad(n) { return (n < 10 ? '0' : '') + n; }
        return pad(Math.floor(s / 3600)) + ':' + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60) + ':' + pad(f);
    }

    // Por qué un corte quedó como estaba (label = 'multicam', 'merged clip', ...).
    function problemReason(match, label) {
        label = label || 'multicam';
        var r = {
            notfound: 'no está en ningún ' + label,
            outofrange: 'está en un ' + label + ' pero ese tramo del archivo no',
            partial: 'solo una parte del tramo está dentro del ' + label,
            nomerged: 'no se pudo leer cómo está armado este merged' + (match.detail ? ' (' + match.detail + ')' : ''),
            novideo: 'el merged no tiene video',
            noaudio: 'el merged no tiene audio',
            noclip: 'el archivo ' + (match.file || '') + ' no está como master clip en el proyecto'
        };
        return r[match.status] || match.status;
    }

    function report(result, ticksPerFrame) {
        var fps = Math.round(TICKS_PER_SECOND / ticksPerFrame);
        function tc(t) { return ticksToTC(t, ticksPerFrame, fps); }
        var label = result.label || 'multicam', out = [], i, p, pr, where;
        out.push('=== ReconformMC: reporte ===');
        out.push((result.flatten ? 'Flatten de merged clips' : 'Destinos (' + label + ') leídos: ' + result.index.multicams.length) +
                 ' | Cortes a reemplazar: ' + result.placements.length +
                 ' | Sin reemplazar: ' + result.problems.length +
                 ' | Salteados: ' + result.skipped.length);
        out.push('');
        out.push('-- Reemplazos --');
        for (i = 0; i < result.placements.length; i++) {
            p = result.placements[i];
            if (result.flatten) { where = p.kind === 'video' ? '  [imagen]' : '  [sonido]'; }
            else if (label === 'multicam') { where = p.match.cameraIndex !== null ? '  [cámara ' + (p.match.cameraIndex + 1) + ']' : '  [audio]'; }
            else { where = ''; }
            out.push('#' + p.id + '  ' + tc(p.start) + '  ' + p.group.name +
                     '  ->  ' + p.match.mcName + where +
                     '  in ' + tc(p.match.mcIn) +
                     (p.kind !== 'video' ? '  A' + (p.audioTrack + 1) + '-A' + (p.audioTrack + p.audioTracks) : '  V' + (p.videoTrack + 1)) +
                     (p.kind !== 'av' && !p.quiet ? '  (' + p.kind + ')' : '') +
                     (p.match.matchedBy === 'nombre' ? '  (sin timecode: ubicado por nombre)' : ''));
        }
        if (result.problems.length) {
            out.push('');
            out.push('-- Sin reemplazar (quedan como estaban) --');
            for (i = 0; i < result.problems.length; i++) {
                pr = result.problems[i];
                out.push(tc(pr.group.start) + '  ' + pr.group.name + ': ' + problemReason(pr.match, label));
            }
        }
        if (result.skipped.length) {
            out.push('');
            out.push('-- Salteados --');
            for (i = 0; i < result.skipped.length; i++) {
                out.push(tc(result.skipped[i].item.start) + '  ' + result.skipped[i].item.name + ': ' + result.skipped[i].reason);
            }
        }
        if (result.warnings.length) {
            out.push('');
            out.push('-- Para revisar --');
            for (i = 0; i < result.warnings.length; i++) {
                out.push('#' + result.warnings[i].placement.id + '  ' + tc(result.warnings[i].placement.start) + ': ' + result.warnings[i].text);
            }
        }
        var cams = [], k;
        for (k in result.cameras) { if (result.cameras.hasOwnProperty(k)) { cams.push('cámara ' + k + ': ' + result.cameras[k].length + ' cortes'); } }
        if (cams.length) { out.push(''); out.push('Ángulos -> ' + cams.join(' | ')); }
        return out.join('\n');
    }

    return {
        TICKS_PER_SECOND: TICKS_PER_SECOND,
        normPath: normPath,
        sourceName: sourceName,
        tcToTicks: tcToTicks,
        parseXmpStartTimecode: parseXmpStartTimecode,
        baseName: baseName,
        buildIndex: buildIndex,
        matchRange: matchRange,
        groupEditItems: groupEditItems,
        allocateAudioTracks: allocateAudioTracks,
        plan: plan,
        planFlatten: planFlatten,
        parseXml: parseXml,
        readXmeml: readXmeml,
        buildMergedTargets: buildMergedTargets,
        readPrprojMerged: readPrprojMerged,
        readPrprojMergedSeqs: readPrprojMergedSeqs,
        readPrprojMergedNames: readPrprojMergedNames,
        normName: normName,
        buildMergedTargetsFromSeq: buildMergedTargetsFromSeq,
        buildMergedTargetsFromProject: buildMergedTargetsFromProject,
        resolveMergedGroup: resolveMergedGroup,
        problemReason: problemReason,
        report: report,
        ticksToTC: ticksToTC
    };
}());

if (typeof module !== 'undefined' && module.exports) { module.exports = ReconformCore; }
