/* ===== app.js – Extracted from Loop.html ===== */

/* ---------- WebAudio: einmalige Normalisierung (inkl. Safari-Fallback) ---------- */
window.AudioContext = window.AudioContext || window.webkitAudioContext;

/* ========== Seiten-Navigation ========== */
    const book      = document.getElementById('book');
    const navPlayer = document.getElementById('navPlayer');
    const navEditor = document.getElementById('navEditor');

    function showRight(){
      book.classList.add('flipped');
      navPlayer.classList.remove('active');
      navEditor.classList.add('active');
      // Beim Wechsel zur Editorseite: Arrangement-Modus oder Standard-Marker-Modus aktualisieren
      try {
        if(arrangementEditorMode){
          // Arrangement-Modus: Segment-Struktur neu berechnen, Lyrics-Inhalte per segKey erhalten
          const newSegs = buildArrangementForEditor();
          if(newSegs.length > 0){
            const oldKeyToLines = new Map();
            for(const oldSeg of arrangementSegments){
              oldKeyToLines.set(oldSeg.segKey, lyrics.slice(oldSeg.lineStartIdx, oldSeg.lineStartIdx + oldSeg.lineCount));
            }
            const newTotal = newSegs[newSegs.length - 1].lineStartIdx + newSegs[newSegs.length - 1].lineCount;
            const newLyrics = new Array(newTotal).fill('');
            for(const newSeg of newSegs){
              const oldLines = oldKeyToLines.get(newSeg.segKey) || [];
              for(let j = 0; j < Math.min(newSeg.lineCount, oldLines.length); j++){
                newLyrics[newSeg.lineStartIdx + j] = oldLines[j] || '';
              }
            }
            lyrics = newLyrics;
            arrangementSegments = newSegs;
          }
        } else {
          // Standard-Modus: Marker-Headers automatisch neu berechnen
          const bl = barLen();
          if (isFinite(bl) && bl > 0) {
            perSegmentLineNumbering = true;
            const headers = [];
            (markers||[])
              .filter(m => (m.label||'').trim().length > 0 && m.playlistClone !== true)
              .forEach(m => {
                const barNumber = Math.floor((m.time + timeTol()) / bl) + 1;
                const lineIdx   = Math.floor((barNumber - 1) / 2) + 1;
                headers.push({ lineIdx, label: m.label.trim(), bar: barNumber });
              });
            headers.sort((a,b) => a.lineIdx - b.lineIdx || a.bar - b.bar);
            markerHeaders = headers;
          } else {
            perSegmentLineNumbering = false;
            markerHeaders = [];
          }
        }
        renderLyricsList();
      } catch(_) {}
      // Immediately highlight + scroll to the current playback line.
      // Reset lastActiveLine so the guard in updateLyricsHighlight doesn't
      // suppress the update (the line may already be "active" from the player
      // side, but the scroll hasn't fired yet because the editor wasn't visible).
      try {
        const t = (typeof usingEngine !== 'undefined' && usingEngine &&
                   typeof getPlayheadTime === 'function')
                  ? getPlayheadTime()
                  : (typeof cursorTime !== 'undefined' ? cursorTime : 0);
        if (typeof lastActiveLine !== 'undefined') lastActiveLine = -1;
        if (typeof updateLyricsHighlight === 'function') updateLyricsHighlight(t);
      } catch(_) {}
    }
    function showLeft(){
      book.classList.remove('flipped');
      navEditor.classList.remove('active');
      navPlayer.classList.add('active');
    }
    navPlayer.addEventListener('click', showLeft);
    navEditor.addEventListener('click', showRight);

    // ESC wechselt zurück zum Player (Quality-of-Life)
    window.addEventListener('keydown', (e)=>{
      if(e.key === 'Escape' && book.classList.contains('flipped')) showLeft();
    });

/* ========== Haupt-App-Logik ========== */
// --- DOM ---
    const fileInput = document.getElementById('file');
    const clearBtn = document.getElementById('clearBtn');
    const saveProjectBtn = document.getElementById('saveProject');
    const loadProjectInput = document.getElementById('loadProjectFile');
    const loadAudioForProject = document.getElementById('loadAudioForProject');
    const fileInfo = document.getElementById('fileInfo');

    const bpmInput = document.getElementById('bpm');
    const playSel = document.getElementById('playSel');
    const pauseBtn = document.getElementById('pauseBtn');

    const addMarkerBtn = document.getElementById('addMarker');
    const deleteMarkerBtn = document.getElementById('deleteMarker');

    const markerListEl = document.getElementById('markerList');
    
    // Reihenfolge-Playback DOM
    const playSeqToggle = document.getElementById('playSeqToggle');
    const seqInfo = document.getElementById('seqInfo');
const wave = document.getElementById('wave');
    const curLabel = document.getElementById('curLabel');
    const ctx = wave.getContext('2d');

    // Trim Buttons
    const trimFrontBtn = document.getElementById('trimFront');
    const trimBackBtn  = document.getElementById('trimBack');
    const undoTrimBtn  = document.getElementById('undoTrim');

    

    const timeSigSelect = document.getElementById('timeSig');
const gridSnapBtn  = document.getElementById('gridSnapBtn');
let snapEnabled = true; // default AN

function updateGridSnapUI(){
  try{
    if(!gridSnapBtn) return;
    gridSnapBtn.classList.toggle('active', !!snapEnabled);
    gridSnapBtn.setAttribute('aria-pressed', String(!!snapEnabled));
    gridSnapBtn.textContent = 'Grid Snap'; // Label bleibt gleich; Status über Highlight
    gridSnapBtn.title = snapEnabled ? 'Cursor am Raster einrasten (AN)' : 'Cursor am Raster einrasten (AUS)';
  }catch(_){}
}
gridSnapBtn?.addEventListener('click', (e)=>{
  snapEnabled = !snapEnabled;
  updateGridSnapUI();
  try{ (e.currentTarget || gridSnapBtn).blur(); }catch(_){}
});

updateGridSnapUI();

// --- Pitch (Semitones) UI & Engine integration ---
const pitchMinusBtn = document.getElementById('pitchMinus');
const pitchPlusBtn  = document.getElementById('pitchPlus');
const pitchValEl    = document.getElementById('pitchVal');
let pitchSt = 0;               // semitones, range -24…+24
let pitchedBuffer = null;      // cached pitch-shifted buffer

function updatePitchUI(){
  try{
    if(pitchValEl) pitchValEl.textContent = (pitchSt >= 0 ? '+' : '') + pitchSt + ' st';
  }catch(_){}
}

// WSOLA pitch shifter – semitone-accurate, duration-preserving, no tempo change.
// Algorithm: (1) WSOLA time-stretch by pitchFactor using fixed output hop (constant 4× overlap),
//            (2) resample stretched result back to original length (restores duration, shifts pitch).
// semitones: Pitch-Verschiebung in Halbtönen
// tempoFactor: Tempo-Faktor (z.B. 1.1 = 10% schneller); wird zusammen mit Pitch
//   in einem einzigen WSOLA-Durchlauf verarbeitet, sodass keine Pitchänderung
//   durch playbackRate entsteht. stretchFactor = pitchFactor / tempoFactor.
function pitchShiftSemitones(srcBuf, semitones, tempoFactor){
  try{
    const pitchFactor = Math.pow(2, semitones / 12);
    const tf = (typeof tempoFactor === 'number' && tempoFactor > 0) ? tempoFactor : 1;
    const combinedFactor = pitchFactor / tf; // WSOLA-Streckfaktor
    if(Math.abs(combinedFactor - 1) < 1e-6 && Math.abs(tf - 1) < 1e-6) return srcBuf;

    const numCh  = srcBuf.numberOfChannels;
    const inLen  = srcBuf.length;
    const sr     = srcBuf.sampleRate;
    const srcCh  = Array.from({length: numCh}, (_, c) => new Float32Array(srcBuf.getChannelData(c)));

    // WSOLA parameters – winSize 4096 / hopOut 1024 keeps 4× overlap while
    // providing better frequency resolution and less phase cancellation vs. 2048/512.
    // Total compute stays the same (fewer frames, larger window).
    const winSize      = 4096;
    const hopOut       = 1024;
    const hopIn        = Math.max(1, Math.round(hopOut / combinedFactor));
    const searchRadius = Math.max(1, Math.floor(hopIn / 2));

    // Hann window
    const hann = new Float32Array(winSize);
    for(let i = 0; i < winSize; i++)
      hann[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (winSize - 1)));

    const outLenOLA = Math.ceil(inLen / hopIn) * hopOut + winSize * 2;
    const outCh  = Array.from({length: numCh}, () => new Float32Array(outLenOLA));
    const wSum   = new Float32Array(outLenOLA);

    let expectedInPos = 0;
    let outPos        = 0;

    while(outPos + winSize <= outLenOLA && expectedInPos < inLen){
      // WSOLA: find best-matching grain near expectedInPos via cross-correlation
      const searchFrom = Math.max(0, Math.min(inLen - winSize, expectedInPos - searchRadius));
      const searchTo   = Math.max(searchFrom, Math.min(inLen - winSize, expectedInPos + searchRadius));
      let bestPos  = Math.min(expectedInPos, inLen - winSize < 0 ? 0 : inLen - winSize);
      let bestCorr = -Infinity;

      if(outPos > 0){
        // Correlate against the already-placed tail at outPos (what we committed so far).
        // 512 samples covers a full period even at ~85 Hz, preventing phase mismatches
        // on bass content that caused the phasing/flanging artifact.
        const refStart = outPos - hopOut;
        for(let s = searchFrom; s <= searchTo; s += 2){
          let dot = 0, srcEnergy = 0;
          const limit = Math.min(512, winSize, inLen - s);
          for(let k = 0; k < limit; k++){
            const oi = refStart + k;
            const ref = (oi >= 0 && oi < outLenOLA && wSum[oi] > 1e-9)
              ? outCh[0][oi] / wSum[oi] : 0;
            const sVal = srcCh[0][s + k] || 0;
            dot       += ref * sVal;
            srcEnergy += sVal * sVal;
          }
          // Normalised cross-correlation: rank candidates by waveform-shape similarity
          // rather than raw amplitude. An unnormalised dot product favours louder grains
          // over better-aligned ones, which is the primary cause of phasing artefacts.
          const corr = srcEnergy > 1e-9 ? dot / Math.sqrt(srcEnergy) : 0;
          if(corr > bestCorr){ bestCorr = corr; bestPos = s; }
        }
      }

      // Overlap-add windowed grain from bestPos
      for(let ch = 0; ch < numCh; ch++){
        for(let i = 0; i < winSize; i++){
          const si = Math.min(bestPos + i, inLen - 1);
          outCh[ch][outPos + i] += (srcCh[ch][si] || 0) * hann[i];
        }
      }
      for(let i = 0; i < winSize; i++) wSum[outPos + i] += hann[i];

      expectedInPos += hopIn;
      outPos        += hopOut;
    }

    // Normalize
    for(let i = 0; i < outLenOLA; i++){
      const w = wSum[i];
      if(w > 1e-9) for(let ch = 0; ch < numCh; ch++) outCh[ch][i] /= w;
    }

    // Measure input RMS (channel 0) before resampling for loudness compensation
    let inRms = 0;
    for(let i = 0; i < inLen; i++) inRms += srcCh[0][i] * srcCh[0][i];
    inRms = Math.sqrt(inRms / inLen);

    // Resample with 4-point cubic Hermite interpolation.
    // Linear interpolation (former) acts as a low-pass filter that attenuates
    // high frequencies and reduces perceived loudness. Cubic interpolation
    // preserves transients and high-frequency content with minimal extra cost.
    const ratio = outLenOLA / inLen;
    const outBuf = new AudioBuffer({ numberOfChannels: numCh, length: inLen, sampleRate: sr });
    for(let ch = 0; ch < numCh; ch++){
      const out = outBuf.getChannelData(ch);
      const src = outCh[ch];
      for(let i = 0; i < inLen; i++){
        const pos = i * ratio;
        const j   = pos | 0;
        const fr  = pos - j;
        const y0  = src[Math.max(0, j - 1)];
        const y1  = src[j];
        const y2  = src[Math.min(outLenOLA - 1, j + 1)];
        const y3  = src[Math.min(outLenOLA - 1, j + 2)];
        const a   = -0.5*y0 + 1.5*y1 - 1.5*y2 + 0.5*y3;
        const b   =      y0 - 2.5*y1 + 2.0*y2 - 0.5*y3;
        const c   = -0.5*y0           + 0.5*y2;
        out[i]    = ((a*fr + b)*fr + c)*fr + y1;
      }
    }

    // RMS gain compensation: correct any energy loss introduced by the WSOLA
    // grain-selection and overlap-add process so output matches input loudness.
    let outRms = 0;
    const outCh0 = outBuf.getChannelData(0);
    for(let i = 0; i < inLen; i++) outRms += outCh0[i] * outCh0[i];
    outRms = Math.sqrt(outRms / inLen);
    if(outRms > 1e-9 && inRms > 1e-9){
      const gain = Math.max(0.5, Math.min(2.0, inRms / outRms));
      for(let ch = 0; ch < numCh; ch++){
        const data = outBuf.getChannelData(ch);
        for(let i = 0; i < inLen; i++) data[i] *= gain;
      }
    }

    return outBuf;
  }catch(err){
    console.warn('pitchShiftSemitones failed:', err);
    return srcBuf;
  }
}

// ============ Async Pitch/Tempo Shift via Web Worker ============
let _pitchWorker = null;
let _pitchJobId  = 0;
let _pitchPending = false;

function _getPitchWorker(){
  if(_pitchWorker) return _pitchWorker;
  const code = `self.onmessage=function(e){
  var d=e.data,jobId=d.jobId,channels=d.channels,numCh=d.numChannels,inLen=d.inLen;
  try{
    var semitones=d.semitones,tf=d.tempoFactor>0?d.tempoFactor:1;
    var pitchFactor=Math.pow(2,semitones/12),combinedFactor=pitchFactor/tf;
    if(Math.abs(combinedFactor-1)<1e-6&&Math.abs(tf-1)<1e-6){
      self.postMessage({jobId:jobId,channels:channels,outLen:inLen},channels.map(function(c){return c.buffer;}));
      return;
    }
    var winSize=4096,hopOut=1024;
    var hopIn=Math.max(1,Math.round(hopOut/combinedFactor));
    var searchRadius=Math.max(1,Math.floor(hopIn/2));
    var hann=new Float32Array(winSize);
    for(var i=0;i<winSize;i++) hann[i]=0.5*(1-Math.cos(2*Math.PI*i/(winSize-1)));
    var outLenOLA=Math.ceil(inLen/hopIn)*hopOut+winSize*2;
    var outCh=[];for(var c=0;c<numCh;c++) outCh.push(new Float32Array(outLenOLA));
    var wSum=new Float32Array(outLenOLA);
    var expectedInPos=0,outPos=0;
    while(outPos+winSize<=outLenOLA&&expectedInPos<inLen){
      var searchFrom=Math.max(0,Math.min(inLen-winSize,expectedInPos-searchRadius));
      var searchTo=Math.max(searchFrom,Math.min(inLen-winSize,expectedInPos+searchRadius));
      var bestPos=Math.min(expectedInPos,inLen-winSize<0?0:inLen-winSize);
      var bestCorr=-Infinity;
      if(outPos>0){
        var refStart=outPos-hopOut;
        for(var s=searchFrom;s<=searchTo;s+=2){
          var dot=0,srcEnergy=0,limit=Math.min(512,winSize,inLen-s);
          for(var k=0;k<limit;k++){
            var oi=refStart+k;
            var ref=(oi>=0&&oi<outLenOLA&&wSum[oi]>1e-9)?outCh[0][oi]/wSum[oi]:0;
            var sVal=channels[0][s+k]||0;
            dot+=ref*sVal;srcEnergy+=sVal*sVal;
          }
          var corr=srcEnergy>1e-9?dot/Math.sqrt(srcEnergy):0;
          if(corr>bestCorr){bestCorr=corr;bestPos=s;}
        }
      }
      for(var ch=0;ch<numCh;ch++){
        for(var i=0;i<winSize;i++){
          var si=Math.min(bestPos+i,inLen-1);
          outCh[ch][outPos+i]+=(channels[ch][si]||0)*hann[i];
        }
      }
      for(var i=0;i<winSize;i++) wSum[outPos+i]+=hann[i];
      expectedInPos+=hopIn; outPos+=hopOut;
    }
    for(var i=0;i<outLenOLA;i++){
      var w=wSum[i];
      if(w>1e-9) for(var ch=0;ch<numCh;ch++) outCh[ch][i]/=w;
    }
    var inRms=0;
    for(var i=0;i<inLen;i++) inRms+=channels[0][i]*channels[0][i];
    inRms=Math.sqrt(inRms/inLen);
    var ratio=outLenOLA/inLen,result=[];
    for(var ch=0;ch<numCh;ch++){
      var out=new Float32Array(inLen),src=outCh[ch];
      for(var i=0;i<inLen;i++){
        var pos=i*ratio,j=pos|0,fr=pos-j;
        var y0=src[Math.max(0,j-1)],y1=src[j];
        var y2=src[Math.min(outLenOLA-1,j+1)],y3=src[Math.min(outLenOLA-1,j+2)];
        var a=-0.5*y0+1.5*y1-1.5*y2+0.5*y3;
        var b=y0-2.5*y1+2.0*y2-0.5*y3;
        var c=-0.5*y0+0.5*y2;
        out[i]=((a*fr+b)*fr+c)*fr+y1;
      }
      result.push(out);
    }
    var outRms=0;
    for(var i=0;i<inLen;i++) outRms+=result[0][i]*result[0][i];
    outRms=Math.sqrt(outRms/inLen);
    if(outRms>1e-9&&inRms>1e-9){
      var gain=Math.max(0.5,Math.min(2.0,inRms/outRms));
      for(var ch=0;ch<numCh;ch++) for(var i=0;i<inLen;i++) result[ch][i]*=gain;
    }
    self.postMessage({jobId:jobId,channels:result,outLen:inLen},result.map(function(c){return c.buffer;}));
  }catch(err){
    self.postMessage({jobId:jobId,error:String(err)});
  }
};`;
  try{
    const blob = new Blob([code], {type:'application/javascript'});
    _pitchWorker = new Worker(URL.createObjectURL(blob));
  }catch(e){ _pitchWorker = null; }
  return _pitchWorker;
}

function _showPitchLoadingUI(on){
  try{ if(pitchMinusBtn) pitchMinusBtn.disabled = on; }catch(_){}
  try{ if(pitchPlusBtn)  pitchPlusBtn.disabled  = on; }catch(_){}
  try{ if(typeof tempoMinusBtn!=='undefined'&&tempoMinusBtn) tempoMinusBtn.disabled = on; }catch(_){}
  try{ if(typeof tempoPlusBtn !=='undefined'&&tempoPlusBtn)  tempoPlusBtn.disabled  = on; }catch(_){}
  try{
    if(on){
      if(pitchValEl) pitchValEl.textContent = 'Lade';
      if(typeof tempoValEl!=='undefined'&&tempoValEl) tempoValEl.value = 'Lade';
    } else {
      updatePitchUI();
      if(typeof updateTempoUI==='function') updateTempoUI();
    }
  }catch(_){}
  // Zentrierter Lade-Spinner
  try{
    var ov = document.getElementById('_pitchSpinnerOverlay');
    if(!ov){
      var st = document.createElement('style');
      st.textContent =
        '@keyframes _pso_spin{to{transform:rotate(360deg)}}' +
        '#_pitchSpinnerOverlay{position:fixed;inset:0;z-index:99998;display:flex;align-items:center;justify-content:center;pointer-events:none;}' +
        '#_pitchSpinnerOverlay._pso_on{pointer-events:all;}' +
        '#_pitchSpinner{width:52px;height:52px;border-radius:50%;border:5px solid rgba(92,158,255,.2);border-top-color:#5c9eff;animation:_pso_spin .75s linear infinite;box-shadow:0 4px 24px rgba(0,0,0,.55);}';
      document.head.appendChild(st);
      ov = document.createElement('div');
      ov.id = '_pitchSpinnerOverlay';
      var sp = document.createElement('div');
      sp.id = '_pitchSpinner';
      ov.appendChild(sp);
      document.body.appendChild(ov);
    }
    if(on){ ov.style.display='flex'; ov.classList.add('_pso_on'); }
    else  { ov.style.display='none'; ov.classList.remove('_pso_on'); }
  }catch(_){}
}

function _triggerPitchTempoAsync(){
  const targetPitchSt = pitchSt;
  const targetTf = (typeof getPlaybackRate==='function') ? getPlaybackRate() : 1;

  // Kein Shift nötig – Engine direkt neu starten
  if(targetPitchSt === 0 && Math.abs(targetTf - 1) < 1e-6){
    pitchedBuffer = null;
    try{ if(usingEngine){ const t=getPlayheadTime(); stopEngine(); startEngineAt(t); } }catch(_){}
    return;
  }

  // Worker nicht verfügbar → synchroner Fallback
  const worker = _getPitchWorker();
  if(!worker){
    try{ if(usingEngine){ const t=getPlayheadTime(); stopEngine(); startEngineAt(t); } }catch(_){}
    return;
  }

  // Engine stoppen, Position merken
  let resumeOffset = null;
  try{ if(usingEngine){ resumeOffset = getPlayheadTime(); stopEngine(); } }catch(_){}

  if(!audioBuffer) return;

  const jobId = ++_pitchJobId;
  _pitchPending = true;
  _showPitchLoadingUI(true);

  const numCh = audioBuffer.numberOfChannels;
  const inLen  = audioBuffer.length;
  const sr     = audioBuffer.sampleRate;

  // Channel-Daten kopieren (Transfer an Worker)
  const channels = [];
  for(let c = 0; c < numCh; c++){
    const copy = new Float32Array(inLen);
    copy.set(audioBuffer.getChannelData(c));
    channels.push(copy);
  }

  function handler(ev){
    if(ev.data.jobId !== jobId) return; // veraltetes Ergebnis verwerfen
    worker.removeEventListener('message', handler);
    _pitchPending = false;
    _showPitchLoadingUI(false);

    if(ev.data.error){
      console.warn('Pitch worker error:', ev.data.error);
      pitchedBuffer = null;
    } else {
      try{
        const outBuf = new AudioBuffer({ numberOfChannels: numCh, length: inLen, sampleRate: sr });
        for(let c = 0; c < numCh; c++) outBuf.getChannelData(c).set(ev.data.channels[c]);
        pitchedBuffer = outBuf;
      }catch(err){
        console.warn('Pitch buffer reconstruct failed:', err);
        pitchedBuffer = null;
      }
    }
    try{ if(resumeOffset !== null) startEngineAt(resumeOffset); }catch(_){}
  }

  worker.addEventListener('message', handler);
  worker.postMessage(
    { jobId, channels, sampleRate: sr, numChannels: numCh, inLen,
      semitones: targetPitchSt, tempoFactor: targetTf },
    channels.map(c => c.buffer)
  );
}
// ============ Ende Async Worker ============

function getPlaybackBuffer(){
  if(!audioBuffer) return null;
  const tf = getPlaybackRate();
  if(pitchSt === 0 && Math.abs(tf - 1) < 1e-6) return audioBuffer;
  if(!pitchedBuffer){
    if(_pitchPending) return audioBuffer; // async läuft – Original als Fallback
    try{
      pitchedBuffer = pitchShiftSemitones(audioBuffer, pitchSt, tf) || audioBuffer;
    }catch(err){
      console.warn('Audio render error, falling back:', err);
      pitchedBuffer = audioBuffer;
    }
  }
  return pitchedBuffer;
}

function setPitch(n){
  const clamped = Math.max(-24, Math.min(24, Math.round(n)));
  if(clamped === pitchSt) return;
  pitchSt = clamped;
  pitchedBuffer = null;
  updatePitchUI();
  _triggerPitchTempoAsync();
}

pitchMinusBtn?.addEventListener('click', ()=> setPitch(pitchSt - 1));
pitchPlusBtn ?.addEventListener('click', ()=> setPitch(pitchSt + 1));
updatePitchUI();

// --- Playback Tempo control ---
const tempoMinusBtn = document.getElementById('tempoMinus');
const tempoPlusBtn  = document.getElementById('tempoPlus');
const tempoValEl    = document.getElementById('tempoVal');
let playbackTempoBpm = null; // null = Projekt-BPM (playbackRate = 1)

function getPlaybackRate(){
  if(playbackTempoBpm === null || !Number.isFinite(playbackTempoBpm)) return 1;
  const proj = bpm();
  if(!proj || proj <= 0) return 1;
  return Math.max(0.1, Math.min(4, playbackTempoBpm / proj));
}


function _tempoNumToStr(val){
  return Number.isFinite(val) ? (val % 1 === 0 ? String(val) : val.toFixed(1)) : '';
}

function updateTempoUI(){
  try{
    if(!tempoValEl) return;
    const val = playbackTempoBpm !== null ? playbackTempoBpm : bpm();
    tempoValEl.value = _tempoNumToStr(val);
  }catch(_){}
}

function _applyTempoToEngine(){
  // Tempo ist im Buffer eingebakt (kombinierter WSOLA-Durchlauf) –
  // Engine muss mit neuem Buffer neu gestartet werden.
  pitchedBuffer = null;
  _triggerPitchTempoAsync();
}

// Für ±-Buttons: Schritt 0,5, auf halbe BPM gerundet
function setPlaybackTempo(n){
  const clamped = Math.max(1, Math.min(999.5, Math.round(n * 2) / 2));
  if(Math.abs(clamped - (playbackTempoBpm ?? bpm())) < 1e-9) return;
  playbackTempoBpm = clamped;
  pitchedBuffer = null;
  updateTempoUI();
  _applyTempoToEngine();
}

// Für manuelle Eingabe: beliebiger Wert (keine 0,5-Rundung)
function setPlaybackTempoManual(n){
  const clamped = Math.max(1, Math.min(999.5, Math.round(n * 100) / 100));
  if(Math.abs(clamped - (playbackTempoBpm ?? bpm())) < 1e-9) return;
  playbackTempoBpm = clamped;
  pitchedBuffer = null;
  updateTempoUI();
  _applyTempoToEngine();
}

tempoMinusBtn?.addEventListener('click', ()=>{
  const cur = playbackTempoBpm !== null ? playbackTempoBpm : bpm();
  setPlaybackTempo(cur - 0.5);
});
tempoPlusBtn?.addEventListener('click', ()=>{
  const cur = playbackTempoBpm !== null ? playbackTempoBpm : bpm();
  setPlaybackTempo(cur + 0.5);
});

// Eingabefeld-Validierung (gleicher Stil wie Projekt-BPM-Feld)
tempoValEl?.addEventListener('keydown', (e) => {
  if(e.key === 'Enter'){ tempoValEl.blur(); return; }
  if(e.ctrlKey || e.metaKey) return;
  const nav = ['Backspace','Delete','Tab','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'];
  if(nav.includes(e.key)) return;
  if(/^\d$/.test(e.key)) return;
  if((e.key === '.' || e.key === ',') && !/[.,]/.test(tempoValEl.value)) return;
  e.preventDefault();
});
tempoValEl?.addEventListener('input', () => {
  let v = tempoValEl.value.replace(/[^\d.,]/g, '').replace(',', '.');
  const parts = v.split('.');
  if(parts.length > 2) v = parts[0] + '.' + parts.slice(1).join('');
  const sepIdx = v.indexOf('.');
  v = sepIdx === -1 ? v.slice(0, 3) : v.slice(0, sepIdx).slice(0, 3) + '.' + v.slice(sepIdx + 1).slice(0, 2);
  if(tempoValEl.value !== v) tempoValEl.value = v;
});
tempoValEl?.addEventListener('change', () => {
  const parsed = parseFloat((tempoValEl.value || '').replace(',', '.'));
  if(Number.isFinite(parsed) && parsed > 0){
    setPlaybackTempoManual(parsed);
  } else {
    updateTempoUI(); // Ungültige Eingabe: Wert wiederherstellen
  }
});

// X-Button: Tempo zurücksetzen auf Projekt-BPM + Pitch auf 0
const tempoResetBtn = document.getElementById('tempoReset');
tempoResetBtn?.addEventListener('click', () => {
  playbackTempoBpm = null;
  pitchSt = 0;
  pitchedBuffer = null;
  updateTempoUI();
  updatePitchUI();
  _applyTempoToEngine();
});

// Anzeige aktualisieren wenn Projekt-BPM geändert wird (solange kein manuelles Tempo gesetzt)
bpmInput.addEventListener('change', ()=>{ if(playbackTempoBpm === null) updateTempoUI(); });
updateTempoUI();

    if (timeSigSelect) {
      timeSigSelect.addEventListener('change', ()=>{
        const v = parseInt(timeSigSelect.value, 10);
        beatsPerBar = (v === 3 ? 3 : 4);
        // Update view constraints and UI
        try {
          minView = Math.max(0.25, gridStep()/4);
          setView(viewStart, viewDur); // re-clamp using new min
          // Rebuild lyrics (2 bars per line) but keep existing content
          rebuildLyrics({ preserve: true });
          draw();
          if (usingEngine) resumeWithUpdatedLoopPreservingPhase();
        } catch(_) {}
      });
      // Ensure initial value matches current beatsPerBar
      try { timeSigSelect.value = String(beatsPerBar); } catch(_) {}
    }

// --- Rechter Editor DOM ---
    const lyricsListEl = document.getElementById('lyricsList');
    const linesInfoEl = document.getElementById('linesInfo');
    const importMarkersBtn = document.getElementById('importMarkersBtn');
    const exportTxtBtn = document.getElementById('exportTxtBtn');
    const toggleAutoscrollBtn = document.getElementById('toggleAutoscroll');
    
    // --- RhymeBrain Mode (off/de/en) ---
    const rhymeModeSelect = document.getElementById('rhymeMode');
    (function initRhymeMode(){
      const saved = (typeof localStorage!=='undefined') ? localStorage.getItem('rhymeMode') : null;
      const mode = (saved === 'off' || saved === 'en' || saved === 'de') ? saved : 'off';
      window.RHYME_MODE = mode;
      if (rhymeModeSelect) rhymeModeSelect.value = mode;
    })();
    rhymeModeSelect?.addEventListener('change', () => {
      const v = rhymeModeSelect.value;
      window.RHYME_MODE = (v === 'off' || v === 'en') ? v : 'de';
      try { localStorage.setItem('rhymeMode', window.RHYME_MODE); } catch(_) {}
    });

    // --- Tap-to-BPM ---
    const tapBpmBtn = document.getElementById('tapBpm');
    if (tapBpmBtn) {
      const tapTimes = [];
      let lastTapMs = 0;
      tapBpmBtn.addEventListener('click', ()=>{
        const now = performance.now();
        // Reset if last tap was too long ago
        if (now - lastTapMs > 2000) tapTimes.length = 0;
        tapTimes.push(now);
        lastTapMs = now;

        if (tapTimes.length >= 2) {
          // Use up to last 8 intervals
          const diffs = tapTimes.slice(-9).map((t,i,arr)=> i>0 ? (t - arr[i-1]) / 1000 : null).filter(v=> v !== null);
          if (diffs.length > 0) {
            // Optional: basic outlier guard
            const avg = diffs.reduce((a,b)=>a+b,0) / diffs.length;
            let est = 60 / avg;
            // Clamp + round to next full integer
            est = Math.max(1, Math.min(999, est));
            const rounded = Math.round(est);
            bpmInput.value = String(rounded);

            try {
              // Recompute derived values
              minView = Math.max(0.25, gridStep()/4);
              // Rebuild text rows but keep existing content
              rebuildLyrics({ preserve: true });
              draw();
              // Do NOT restart the engine here – marker times and the audio buffer
              // are unaffected by a BPM change, so restarting would only cause a
              // click/pop in the audio. Just refresh visuals while playback runs.
              if (!usingEngine) {
                updateLyricsHighlight(cursorTime);
                updateMarkerRowHighlight(cursorTime);
              }
            } catch(_){}
          }
        }
      });
    }


    // --- State ---
    let objectUrl = null, relativeAudioName = null;
    let duration = 0, audioBuffer = null, sampleRate = 44100;
    // Reihenfolge-Playback State
    let playSeqOrder = false;
    let seqCurrentStartId = null;

    let loadedFileMeta = null;

    let beatsPerBar = 4;
    const EPS = 1e-6;

    
    
    // Sample-aware time tolerance: one sample at the current sampleRate (fallback to 44.1k)
    function timeTol(){
      try{
        const sr = (audioBuffer && audioBuffer.sampleRate) ? (audioBuffer.sampleRate|0) : ((typeof sampleRate!=='undefined' && sampleRate) ? (sampleRate|0) : 44100);
        const tol = 1 / Math.max(1, sr);
        return Math.max(EPS, tol);
      }catch(_){ return EPS; }
    }

// Oberer/unterer Rahmenbereich außerhalb der Waveform
    const FRAME_PAD = 52;

// Marker: { id, time, label, active, listOrder }
    let markers = [];
    let cursorTime = 0;

    // Lyrics/Textzeilen-State (eine Zeile = 2 Takte)
    let lyrics = []; // Array<string>
    let markerHeaders = []; // aus Markern generierte Abschnittsüberschriften
    let perSegmentLineNumbering = false;
    let autoScrollEnabled = true; // Autoscroll-Toggle
    let lastActiveLine = -1; // Index der aktuell gehighlighteten Zeile

    // Custom-Arrangement-Editor-Modus
    let arrangementEditorMode = false; // true = Zeilenlayout folgt Custom Arrangement
    let arrangementSegments = [];
    let _arrangementRestoreData = null; // Gespeicherte Arrangement-Daten beim Projekt-Laden
    let orphanedLines = []; // [{label:string, lines:string[]}] – verwaiste Zeilen nach "Nein"-Löschen
    // arrangementSegments[i] = {
    //   markerId, label, audioStart, audioEnd,
    //   isClone, cloneOf, repIndex, totalReps,
    //   lineStartIdx, lineCount, segKey
    // }

    // Viewport
    let viewStart = 0;   // s
    let viewDur = 0;     // s
    let minView = 0.25;

    // Gesten
    const activePointers = new Map();
    let draggingCursor=false, draggingPan=false;
    let panStartX=0, panStartViewStart=0;
    let pinchStartDist = 0, pinchCenterTime = 0, pinchStartViewDur = 0;

    
    // NEU: Tap-to-seek
    let tapCandidate = false;   // echter Tap ohne nennenswerte Bewegung?
    let downX = 0, downY = 0;   // Startposition für Tap-/Pan-Erkennung
    // Tap auf Marker-Label?
    let tapOnMarkerLabel = false;
// Label-Interaktion
    const renderHit = new Map();
    let tapTimer=null, lastTapId=null, longTimer=null, draggingMarkerId=null;

    // WebAudio
    let ac=null, masterGain=null, engineSource=null, engineGain=null, usingEngine=false;
    let rafId=0, engineStartCtxTime=0, engineStartOffset=0;

    // Geteilter, leichtgewichtiger Context nur fürs Dekodieren (wird nicht geschlossen,
    // da AudioContext-Erstellung teuer ist und das Limit von 6 Contexts pro Seite gilt)
    let _decodeAC = null;
    function getDecodeAC(){
      if(!_decodeAC || _decodeAC.state === 'closed'){
        _decodeAC = new AudioContext();
      }
      return _decodeAC;
    }

    // === Trim persistence (seconds in ORIGINAL file timeline) ===
    // start: inclusive, end: exclusive; when no trim yet, end === original duration
    let projectTrim = { start: 0, end: null };
    // Holds last loaded project JSON until the user selects the audio file.
    let pendingProject = null;
    let loadedProjectMarkerBase = 'trimmed';


    
    
    // === Undo Stack ===
    const UNDO_LIMIT = 10;
    const undoStack = [];

    function cloneAudioBuffer(buf){
      if(!buf) return null;
      const sr = buf.sampleRate|0;
      const numCh = buf.numberOfChannels|0;
      const len = buf.length|0;
      const out = createNewBuffer(numCh, len, sr);
      if(!out) return null;
      for(let ch=0; ch<numCh; ch++){
        out.getChannelData(ch).set(buf.getChannelData(ch));
      }
      return out;
    }

    function pushEditorState(reason='trim'){
      // Speichere Audio + Marker + Cursor + View
      try{
        const snap = {
          audio: cloneAudioBuffer(audioBuffer),
          markers: JSON.parse(JSON.stringify(markers||[])),
          cursorTime,
          viewStart,
          viewDur
        };
        undoStack.push(snap);
        while(undoStack.length > UNDO_LIMIT) undoStack.shift();
      }catch(e){
        console.warn('Undo push failed', e);
      }
    }

    function restoreEditorState(snap){
      if(!snap || !snap.audio) return;
      audioBuffer = snap.audio;
      pitchedBuffer = null;
      duration = audioBuffer.duration || 0;
      sampleRate = audioBuffer.sampleRate || sampleRate;
      markers = Array.isArray(snap.markers) ? snap.markers : [];
      cursorTime = Math.min(Math.max(0, snap.cursorTime||0), duration);
      // View
      minView = Math.max(0.25, gridStep()/4);
      setView(Math.max(0, Math.min(snap.viewStart||0, Math.max(0, duration-minView))), 
              Math.max(minView, Math.min(snap.viewDur||duration, duration)));
      renderMarkerList?.();
      rebuildLyrics({ preserve:true });
      draw();
      if(usingEngine) { stopEngine(); }
    }

    function undoTrim(){
      const snap = undoStack.pop();
      if(!snap){
        // kleiner blink/feedback?
        // Optional: shake button or toast
        return;
      }
      restoreEditorState(snap);
    }

    undoTrimBtn?.addEventListener('click', undoTrim);

    // === Trim Funktionen (Front/Back) ===
    function createNewBuffer(numCh, length, sr){
      // new AudioBuffer() ist seit Chrome 55 / Firefox 53 / Safari 14.1 verfügbar
      // und braucht keinen laufenden AudioContext
      try{
        return new AudioBuffer({ numberOfChannels: numCh, length, sampleRate: sr });
      }catch(_){
        // Fallback: vorhandenen AC nutzen (vermeidet temporären Context)
        try{
          ensureAC();
          return ac.createBuffer(numCh, length, sr);
        }catch(e){
          console.warn('Buffer create failed:', e);
          return null;
        }
      }
    }

    function replaceAudioBuffer(newBuf){
      if(!newBuf) return;
      audioBuffer = newBuf;
      pitchedBuffer = null; // Pitch Cache invalidieren
      duration = audioBuffer.duration || 0;
      sampleRate = audioBuffer.sampleRate || sampleRate;
      // Cursor & View neu setzen
      cursorTime = Math.min(cursorTime, duration);
      minView = Math.max(0.25, gridStep()/4);
      setView(0, Math.max(minView, Math.min(viewDur||duration, duration)));
      // Start/End Marker sicherstellen/aktualisieren
      let startM = markers.find(m=>m.pin==='start');
      let endM   = markers.find(m=>m.pin==='end');
      if(!startM || !endM){
        markers = markers.filter(m=>!m.pin); // alles außer pins behalten, dann frisch anlegen
        markers.unshift({ id: uid(), time: 0, label: 'Start', active: true,  pin: 'start', listOrder: 0, seqReps: 1 });
        markers.push({ id: uid(), time: duration, label: 'Ende', active: true,  pin: 'end', listOrder: 1 });
      }else{
        startM.time = 0;
        endM.time = duration;
      }
      reindexListOrder();
      renderMarkerList?.();
      rebuildLyrics({ preserve:true });
      draw();
      if(usingEngine) { stopEngine(); } // nach Trim immer stoppen
    }

    
    // Apply projectTrim to a source buffer (slice [start,end)) and shift/clamp markers accordingly.
    function applyProjectTrimOnBuffer(srcBuf){
      try{
        if(!srcBuf) return null;
        const sr = srcBuf.sampleRate|0;
        const fullDur = srcBuf.duration||0;
        const sSec = Math.max(0, Math.min(fullDur, Number.isFinite(projectTrim.start)? projectTrim.start : 0));
        const eSecRaw = Number.isFinite(projectTrim.end) ? projectTrim.end : fullDur;
        const eSec = Math.max(sSec, Math.min(fullDur, eSecRaw));
        const sSmp = Math.floor(sSec * sr);
        const eSmp = Math.floor(eSec * sr);
        const outLen = Math.max(0, eSmp - sSmp);
        const numCh = srcBuf.numberOfChannels|0;
        const out = createNewBuffer(numCh, outLen, sr);
        if(!out) return null;
        for(let ch=0; ch<numCh; ch++){
          const src = srcBuf.getChannelData(ch);
          out.getChannelData(ch).set(src.subarray(sSmp, eSmp), 0);
        }
        // Shift & clamp markers from original timeline into trimmed timeline
        try{
          if(Array.isArray(markers)){
            const newDurSec = outLen / sr;
            markers = markers
              .map(m => ({ ...m, time: Math.max(0, Math.min(newDurSec, (m.time||0) - (((pendingProject && pendingProject.markerTimeBase) ? pendingProject.markerTimeBase : loadedProjectMarkerBase) === 'original' ? sSec : 0))) }))
              .filter(m => m.time >= -EPS && m.time <= newDurSec + EPS);
          }
        }catch(_){}
        return out;
      }catch(_){ return null; }
    }

function trimAtCursorFront(){
      pushEditorState("trimFront");
      if(!audioBuffer || !Number.isFinite(cursorTime)) return;
      const at = clamp(cursorTime, 0, duration);
      // Persist trim (front): move start forward by 'at'; keep previous end
      try{
        const prevStart = Number.isFinite(projectTrim.start) ? projectTrim.start : 0;
        const prevEnd = Number.isFinite(projectTrim.end) ? projectTrim.end : (prevStart + duration);
        projectTrim.start = prevStart + at;
        projectTrim.end = prevEnd;
      }catch(_){}

      const sr = audioBuffer.sampleRate|0;
      const atSmp = Math.floor(at * sr);
      const numCh = audioBuffer.numberOfChannels|0;
      const inLen = audioBuffer.length|0;
      const outLen = Math.max(0, inLen - atSmp);
      const newBuf = createNewBuffer(numCh, outLen, sr);
      if(!newBuf) return;

      for(let ch=0; ch<numCh; ch++){
        const src = audioBuffer.getChannelData(ch);
        const dst = newBuf.getChannelData(ch);
        dst.set(src.subarray(atSmp, inLen), 0);
      }

      // Marker verschieben (alles vor Cursor fällt weg)
      markers = markers
        .map(m=> ({ ...m, time: clamp(m.time - at, 0, (outLen/sr)) }))
        .filter(m=> m.time >= 0 - EPS && m.time <= (outLen/sr) + EPS);

      replaceAudioBuffer(newBuf);
      // Cursor an den Anfang
      setCursor(0, true);
      draw();
    }

    function trimAtCursorBack(){
      pushEditorState("trimBack");
      if(!audioBuffer || !Number.isFinite(cursorTime)) return;
      const at = clamp(cursorTime, 0, duration);
      // Persist trim (back): new end is start + 'at'
      try{
        const s0 = Number.isFinite(projectTrim.start) ? projectTrim.start : 0;
        projectTrim.end = s0 + at;
      }catch(_){}

      const sr = audioBuffer.sampleRate|0;
      const atSmp = Math.floor(at * sr);
      const numCh = audioBuffer.numberOfChannels|0;
      const newBuf = createNewBuffer(numCh, atSmp, sr);
      if(!newBuf) return;

      for(let ch=0; ch<numCh; ch++){
        const src = audioBuffer.getChannelData(ch);
        const dst = newBuf.getChannelData(ch);
        dst.set(src.subarray(0, atSmp), 0);
      }

      // Marker abschneiden (alles nach Cursor fällt weg)
      markers = markers
        .filter(m=> m.time <= at + EPS)
        .map(m=> ({ ...m, time: clamp(m.time, 0, at) }));

      replaceAudioBuffer(newBuf);
      // Cursor ans neue Ende snappen
      setCursor(duration, true);
      draw();
    }

    trimFrontBtn?.addEventListener('click', trimAtCursorFront);
    trimBackBtn ?.addEventListener('click', trimAtCursorBack);

    // --- Utils ---
    function uid(){ return Math.random().toString(36).slice(2,9); }
    function clamp(v,min,max){ return Math.min(max,Math.max(min,v)); }
    function formatTime(t){
      if(!isFinite(t)) t=0;
      const h = Math.floor(t/3600);
      const m = Math.floor((t%3600)/60);
      const s = Math.floor(t%60);
      const ms = Math.round((t%1)*1000);
      if(h>0) return `${h}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}.${ms.toString().padStart(3,'0')}`;
      return `${m}:${s.toString().padStart(2,'0')}.${ms.toString().padStart(3,'0')}`;
    }
    function shortTimeLabel(t){
      const h = Math.floor(t/3600), m = Math.floor((t%3600)/60), s = Math.floor(t%60);
      if(h>0) return `${h}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
      if(m>0) return `${m}:${s.toString().padStart(2,'0')}`;
      return `${s}s`;
    }
    function bpm(){ const v=parseFloat((bpmInput.value||'').replace(',','.')); return isFinite(v)&&v>0?v:120; }
    function barLen(){ return (60 / bpm()) * beatsPerBar; }
    function gridStep(){ return barLen()*2; }
    function snapToGrid(t){ const step=gridStep(); return Math.round(t/step)*step; }
    function viewEnd(){ return viewStart + viewDur; }
    function setView(start, dur){
      if(duration<=0){ viewStart=0; viewDur=0; return; }
      const minDur = Math.min(Math.max(minView, gridStep()/4), duration);
      const newDur = clamp(dur, minDur, duration);
      const maxStart = Math.max(0, duration - newDur);
      viewStart = clamp(start, 0, maxStart);
      viewDur = newDur;
    }
    function timeToX(t, w){ return ((t - viewStart) / viewDur) * w; }
    function xToTime(x, w){ return viewStart + (x / w) * viewDur; }
// --- List-Order Helpers for draggable marker list ---
function ensureListOrder(){
  if(!Array.isArray(markers)) return;
  let changed = false;
  for(let i=0;i<markers.length;i++){
    if(!Number.isFinite(markers[i].listOrder)){ markers[i].listOrder = i; changed = true; }
  }
  if(changed){
    markers.sort((a,b)=> (a.listOrder ?? 0) - (b.listOrder ?? 0));
  }
}
function reindexListOrder(){
  markers.forEach((m,i)=> m.listOrder = i);
}
function reorderById(dragId, newIndex){
  const ordered = markers.slice().sort((a,b)=> (a.listOrder ?? 0) - (b.listOrder ?? 0));
  const from = ordered.findIndex(m=>m.id===dragId);
  if(from<0) return;
  // Prevent moving pinned start/end directly
  if(ordered[from].pin !== 'start' && ordered[from].pin !== 'end'){
    // Remove the dragged item
    const [item] = ordered.splice(from,1);
    // Compute safe insertion window (only end pin is fixed at the back; start pin is freely reorderable)
    let eIdx = ordered.findIndex(m=>m.pin==='end');
    let target = Math.max(0, Math.min(newIndex, ordered.length));
    if(eIdx !== -1) target = Math.min(target, eIdx);
    ordered.splice(target, 0, item);
  }
  // Enforce pinned positions: end last (start pin is free in Custom Arrangement)
  let idxE = ordered.findIndex(m=>m.pin==='end');
  if(idxE >= 0 && idxE !== ordered.length-1){ const [e] = ordered.splice(idxE,1); ordered.push(e); }
  ordered.forEach((m,i)=> m.listOrder = i);
  markers = ordered; // keep array in UI order
}

// Insert a marker so that UI order is: [auto-Start] + others ASC by time + [auto-End]
function insertMarkerAscending(newM){
  ensureListOrder();
  const ordered = markers.slice().sort((a,b)=> (a.listOrder ?? 0) - (b.listOrder ?? 0));
  const hasStart = ordered.some(m=>m.pin==='start');
  const hasEnd   = ordered.some(m=>m.pin==='end');
  const middle = ordered.filter(m=> m.pin!=='start' && m.pin!=='end');
  // Find insertion index within middle by time ascending
  let ins = middle.findIndex(m=> newM.time <= m.time);
  if(ins < 0) ins = middle.length;
  middle.splice(ins, 0, newM);
  let rebuilt = [];
  if(hasStart){ const s = ordered.find(m=>m.pin==='start'); if(s) rebuilt.push(s); }
  rebuilt = rebuilt.concat(middle);
  if(hasEnd){ const e = ordered.find(m=>m.pin==='end'); if(e) rebuilt.push(e); }
  if(!hasStart && !hasEnd){ rebuilt = ordered.concat([newM]).sort((a,b)=> a.time - b.time); }
  if(hasStart && !hasEnd){
    const rest = ordered.filter(m=> m.pin!=='start');
    const tmp = rest.concat([newM]).sort((a,b)=> a.time - b.time);
    rebuilt = [ordered.find(m=>m.pin==='start')].concat(tmp);
  }
  if(!hasStart && hasEnd){
    const rest = ordered.filter(m=> m.pin!=='end');
    const tmp = rest.concat([newM]).sort((a,b)=> a.time - b.time);
    rebuilt = tmp.concat([ordered.find(m=>m.pin==='end')]);
  }
  rebuilt.forEach((m,i)=> m.listOrder = i);
  markers = rebuilt;
}


    function getActiveMarkersSorted(){
      return markers.filter(m=>m.active && !m.playlistClone).sort((a,b)=>a.time-b.time).slice(0,2);
    }
    function ensureMaxTwoActive(toggled){
      const act = markers.filter(m=>m.active);
      if(act.length <= 2) return;
      const others = act.filter(m=>m.id!==toggled.id);
      let closest = others[0], best = Math.abs(others[0].time - toggled.time);
      for(let i=1;i<others.length;i++){
        const d = Math.abs(others[i].time - toggled.time);
        if(d < best){ best = d; closest = others[i]; }
      }
      closest.active = false;
    }

    // --- Loop / Playback ---
    
// === Quick Loop: State & Helpers ===
const quickLoop = { active:false, a:null, b:null };
try{ window.quickLoop = quickLoop; }catch(_){}
let qlLongTimer = null;
const QL_LONG_MS = 350;   // Long-Press Schwelle
const QL_MOVE_TOL = 8;    // Bewegungs-Toleranz gegen versehentliches Ziehen

function lineStartTimeFromIndex(lineIdx0){
  if (arrangementEditorMode && arrangementSegments.length > 0) {
    for (const seg of arrangementSegments) {
      if (lineIdx0 >= seg.lineStartIdx && lineIdx0 < seg.lineStartIdx + seg.lineCount) {
        const bl = barLen();
        return Math.max(0, seg.audioStart + (lineIdx0 - seg.lineStartIdx) * 2 * bl);
      }
    }
    return 0;
  }
  const bl = barLen();         // 1 Takt
  return Math.max(0, lineIdx0 * 2 * bl); // 2 Takte pro Zeile
}
function applyQuickLoopClasses(){
  const rows = lyricsListEl.querySelectorAll('.lyricsRow');
  rows.forEach((row, i)=>{
    const idxEl = row.querySelector('.idx');
    if(!idxEl) return;
    idxEl.classList.remove('ql-active');
    if(quickLoop.active){
      if(i === quickLoop.a || i === quickLoop.b) idxEl.classList.add('ql-active');
    }
  });
}
function clearQuickLoop(){
  quickLoop.active = false; quickLoop.a = null; quickLoop.b = null;
  applyQuickLoopClasses(); draw();
  if(usingEngine) resumeWithUpdatedLoopPreservingPhase();
}
function setQuickLoopFromLines(i0, i1){
  const a = Math.min(i0, i1), b = Math.max(i0, i1);
  quickLoop.active = true; quickLoop.a = a; quickLoop.b = b;
  applyQuickLoopClasses(); draw();
  if(usingEngine) resumeWithUpdatedLoopPreservingPhase();
}
// === End Quick Loop: State & Helpers ===


function getLoopRegion(){
  // 1) Quick-Loop hat Vorrang, wenn Start und Ende gesetzt
  if(quickLoop.active && quickLoop.a !== null && quickLoop.b !== null){
    const s = lineStartTimeFromIndex(Math.min(quickLoop.a, quickLoop.b));
    const e = lineStartTimeFromIndex(Math.max(quickLoop.a, quickLoop.b)) + gridStep(); // + 2 Takte
    return { s: clamp(s,0,duration), e: clamp(e,0,duration), mode:'quick' };
  }
  // 2) Fallback: Marker
  const act = getActiveMarkersSorted();
  if(act.length===2){
    const s=Math.min(act[0].time,act[1].time), e=Math.max(act[0].time,act[1].time);
    return { s, e, mode:'markers' };
  }
  return { s:0, e:duration, mode:'full' };
}

    function getPlayheadTime(){
  if(usingEngine && ac && engineSource){
    const { s, e, mode } = getLoopRegion();
    const rate = (typeof getPlaybackRate === 'function') ? getPlaybackRate() : 1;
    const tCtx = (ac.currentTime - engineStartCtxTime) * rate;
    let t = engineStartOffset + tCtx;

    if (mode === 'markers' || mode === 'quick') {
      // Erst NACH dem Ende wrappen – bis dahin echte "lineare" Zeit anzeigen.
      // Wurde rechts außerhalb des Loopbereichs gestartet (engineStartOffset >= e),
      // NICHT wrappen – der Cursor soll linear von dort weiter laufen.
      if (t >= e && engineStartOffset < e) {
        const L = Math.max(1e-9, e - s);
        // ab dem ersten Überschreiten von e in [s, e) wrappen
        t = s + ((((t - e) % L) + L) % L);
      }
      // Vor dem ersten Pass darf t auch < s sein, wenn außerhalb gestartet wurde
    }
    return clamp(t, 0, duration);
  }
  return cursorTime;
}

    function startPump(){
      if(rafId) cancelAnimationFrame(rafId);
      const pump = () => {
        const t = getPlayheadTime();
        cursorTime = t;
        curLabel.textContent = formatTime(t);
        draw();
        updateLyricsHighlight(t);
        updateMarkerRowHighlight(t);
        rafId = requestAnimationFrame(pump);
      };
      rafId = requestAnimationFrame(pump);
    }
    function stopPump(){
      if(rafId){ cancelAnimationFrame(rafId); rafId=0; }
    }

    function ensureAC(){
      if(!ac){
        // latencyHint:'interactive' → minimale Latenz beim Play-Start; Glitch-Schutz übernimmt das 5ms-Scheduling in startEngineAt
        ac = new AudioContext({ latencyHint: 'interactive' });
        masterGain = ac.createGain();
        masterGain.gain.value = 1;
        masterGain.connect(ac.destination);
      }
    }
    async function ensureACResumed(){
      ensureAC();
      // 'interrupted' tritt auf iOS Safari auf wenn die App in den Hintergrund geht
      if(ac.state === 'suspended' || ac.state === 'interrupted'){
        try{ await ac.resume(); }
        catch(e){ console.warn('AudioContext.resume() fehlgeschlagen:', e); }
      }
    }

    function stopEngine(){
  // Nur wenn gerade gespielt wird: aktuellen Playhead erfassen und snappen
  const wasPlaying = usingEngine && ac && engineSource;
  let snapped = null;
  if (wasPlaying) {
    const tNow = getPlayheadTime();
    snapped = (typeof snapEnabled!=='undefined' && snapEnabled) ? clamp(snapToGrid(tNow), 0, duration || 0) : tNow;
  }

  // Engine sauber stoppen
  if (engineSource){ try{ engineSource.stop(); }catch(_){} try{ engineSource.disconnect(); }catch(_){} engineSource = null; }
  if (engineGain){ try{ engineGain.disconnect(); }catch(_){} engineGain = null; }
  usingEngine = false;
  stopPump();

  // Cursor auf Raster setzen (nur wenn vorher Playback lief)
  if (wasPlaying && snapped !== null) {
    cursorTime = snapped;
    curLabel.textContent = formatTime(cursorTime);
  }

  draw();
  updateLyricsHighlight(cursorTime);
      updateMarkerRowHighlight(cursorTime);
}

  function startEngineAt(offset){
  if(!audioBuffer) return alert('Bitte zuerst eine Audiodatei laden.');
  ensureAC();

  if(engineSource){ try{engineSource.stop();}catch(_){} try{engineSource.disconnect();}catch(_){} }
  const loop = getLoopRegion();
  const src = ac.createBufferSource();
  src.buffer = getPlaybackBuffer() || audioBuffer;
  try{ src.playbackRate.value = getPlaybackRate(); }catch(_){}

  // Start exakt ab Cursor (egal ob innerhalb oder außerhalb des Loopbereichs)
  const startAt = clamp(offset, 0, duration);

  // Looping aktivieren, aber NUR wenn der Start VOR dem Loop-Ende liegt.
  // Startet der Cursor rechts vom Loopbereich, würde die Web Audio API bei
  // loop=true sofort zu loopStart springen – das ist unerwünscht.
  const isLoopMode = (loop.mode === 'markers' || loop.mode === 'quick');
  const loopEnd = (loop.e > 0 ? loop.e : duration);
  src.loop = isLoopMode && (startAt < loopEnd);
  src.loopStart = loop.s;
  src.loopEnd = loopEnd;

  // 5 ms Scheduling-Vorlauf: gibt dem Audio-Thread Zeit den Befehl zu verarbeiten
  // bevor der geplante Zeitpunkt eintrifft (vermeidet Knackser beim Start)
  const scheduleTime = ac.currentTime + 0.005;

  const g = ac.createGain();
  g.gain.setValueAtTime(0, scheduleTime);
  g.gain.linearRampToValueAtTime(1, scheduleTime + 0.005);
  src.connect(g); g.connect(masterGain);

  engineSource = src;
  engineGain = g;
  engineStartCtxTime = scheduleTime;
  engineStartOffset  = startAt;

  // Wenn das Audio-Ende auf natürlichem Weg (loop=false) erreicht wird,
  // Playback sauber stoppen – außer im Custom-Arrangement (seqMonitor übernimmt dort).
  src.onended = function() {
    if (!usingEngine || engineSource !== src) return;          // bereits gestoppt oder neue Source → ignorieren
    if (typeof playSeqOrder !== 'undefined' && playSeqOrder &&
        !(window.quickLoop && window.quickLoop.active)) return; // Custom Arrangement → kein Stopp
    stopEngine();
  };

  try { src.start(scheduleTime, startAt); } catch(e){ console.warn(e); return; }
  usingEngine = true;
  startPump();
  updateLyricsHighlight(startAt);
}

    function restartEngineAt(t){ if(!audioBuffer) return; startEngineAt(t); }

    function resumeWithUpdatedLoopPreservingPhase(){
      if(!usingEngine){ draw(); updateLyricsHighlight(cursorTime);
      updateMarkerRowHighlight(cursorTime); return; }
      const prevT = getPlayheadTime();
      const {s,e} = getLoopRegion();
      let target = prevT;
      if(prevT < s || prevT >= e) target = s;
      startEngineAt(target);
    }

    // ---------- Texteditor-Logik ----------
    function computeCounts(){
      if(arrangementEditorMode && arrangementSegments.length > 0){
        const totalLines = arrangementSegments[arrangementSegments.length - 1].lineStartIdx
                         + arrangementSegments[arrangementSegments.length - 1].lineCount;
        return { bars: totalLines * 2, lines: totalLines };
      }
      if(!duration || !isFinite(duration)) return { bars:0, lines:0 };
      const bl = barLen();
      if(!isFinite(bl) || bl<=0) return { bars:0, lines:0 };
      const bars = Math.floor((duration + timeTol()) / bl); // nur volle Takte
      const lines = Math.floor(bars / 2); // 2 Takte pro Zeile
      return { bars, lines };
    }

        function renderLyricsList(){
      const { bars, lines } = computeCounts();
      if (linesInfoEl) linesInfoEl.textContent = `Takte: ${bars} • Zeilen: ${lines}`;
      lyricsListEl.innerHTML = '';

      // Map der Segment-Header pro Zeile (1-basiert)
      const headersByLine = new Map();
      // Set der gemuteten Zeilenindizes für schnellen Lookup
      const mutedLineSet = new Set();
      if(arrangementEditorMode && arrangementSegments.length > 0){
        for(const seg of arrangementSegments){
          if(seg.isMuted){
            for(let j = 0; j < seg.lineCount; j++) mutedLineSet.add(seg.lineStartIdx + j);
          }
        }
      }

      if(arrangementEditorMode && arrangementSegments.length > 0){
        // Im Arrangement-Modus: Header aus arrangementSegments ableiten
        for(const seg of arrangementSegments){
          const lineIdx1 = seg.lineStartIdx + 1; // 1-basiert
          if(!headersByLine.has(lineIdx1)) headersByLine.set(lineIdx1, []);
          // Bezeichnung: Klone bekommen "(Kopie)", seqReps>1 bekommt "(1/N)"
          let headerLabel = seg.label || '–';
          if(seg.totalReps > 1) headerLabel += ' (' + (seg.repIndex + 1) + '/' + seg.totalReps + ')';
          headersByLine.get(lineIdx1).push({ lineIdx: lineIdx1, label: headerLabel, bar: 0, isClone: seg.isClone, isMuted: seg.isMuted });
        }
      } else {
        markerHeaders.forEach(h=>{
          if(h.lineIdx>=1 && h.lineIdx<=lines){
            if(!headersByLine.has(h.lineIdx)) headersByLine.set(h.lineIdx, []);
            headersByLine.get(h.lineIdx).push(h);
          }
        });
      }
      // --- Berechnung der Segmentstarts für per-segment Zeilennummern ---
      let segStarts = [];
      if(arrangementEditorMode && arrangementSegments.length > 0){
        segStarts = arrangementSegments.map(s => s.lineStartIdx + 1).filter(v => v >= 1);
        if(segStarts.length > 0 && segStarts[0] !== 1) segStarts.unshift(1);
      } else if (perSegmentLineNumbering && Array.isArray(markerHeaders) && markerHeaders.length > 0) {
        const s = new Set();
        markerHeaders.forEach(h => { if (Number.isFinite(h.lineIdx)) s.add(Math.max(1, Math.floor(h.lineIdx))); });
        segStarts = Array.from(s).sort((a,b)=>a-b);
        if (segStarts[0] !== 1) segStarts.unshift(1);
      }
      let segPtr = 0;


      for(let i=0;i<lines;i++){
        // Segment-Header VOR der Zeile einfügen (i ist 0-basiert, Lines 1-basiert)
        const headers = headersByLine.get(i+1) || [];
        headers.sort((a,b)=> a.bar - b.bar);
        headers.forEach(h=>{
          const seg = document.createElement('div');
          seg.className = 'segmentHeader' + (h.isClone ? ' clone' : '') + (h.isMuted ? ' muted' : '');
          seg.textContent = `${h.label}`;
          lyricsListEl.appendChild(seg);
        });

        const row = document.createElement('div');
        row.className = 'lyricsRow' + (mutedLineSet.has(i) ? ' muted' : '');
        row.dataset.idx = i;
        const idx = document.createElement('div'); idx.className = 'idx'; let __displayIdx = i + 1;
        if (perSegmentLineNumbering && segStarts.length) {
          while ((segPtr + 1) < segStarts.length && (i + 1) >= segStarts[segPtr + 1]) segPtr++;
          __displayIdx = (i + 1) - segStarts[segPtr] + 1;
        }
        idx.textContent = String(__displayIdx);
// --- Tap & Long-Press auf die Zeilennummer ---
let downX=0, downY=0, pressed=false, longFired=false;
idx.addEventListener('pointerdown', (ev)=>{
  idx.setPointerCapture?.(ev.pointerId);
  pressed=true; longFired=false;
  downX=ev.clientX; downY=ev.clientY;
  qlLongTimer = setTimeout(()=>{
    longFired = true;
    if(!quickLoop.active){
      quickLoop.active = true; quickLoop.a = i; quickLoop.b = null;
    }else if(quickLoop.active && quickLoop.b===null){
      if(i === quickLoop.a){
        clearQuickLoop();
      }else{
        setQuickLoopFromLines(quickLoop.a, i);
      }
    }else{
      if(i === quickLoop.a || i === quickLoop.b){
        clearQuickLoop();
      }else{
        quickLoop.active = true; quickLoop.a = i; quickLoop.b = null;
        applyQuickLoopClasses(); draw();
        if(usingEngine) resumeWithUpdatedLoopPreservingPhase();
      }
    }
    applyQuickLoopClasses();
  }, QL_LONG_MS);
});
idx.addEventListener('pointermove', (ev)=>{
  if(!pressed) return;
  if(Math.hypot(ev.clientX-downX, ev.clientY-downY) > QL_MOVE_TOL){
    clearTimeout(qlLongTimer); qlLongTimer = null;
  }
});
idx.addEventListener('pointerup', (ev)=>{
  if(!pressed) return;
  pressed=false;
  clearTimeout(qlLongTimer); qlLongTimer=null;
  if(!longFired){
    const t = lineStartTimeFromIndex(i);
    // Fix: Bei Kopiespuren muss _seqTapHlId auf die Marker-ID des geklickten
    // Segments gesetzt werden, damit Highlighting und Playback die Kopiespur
    // verfolgen und nicht immer zur Originalspur springen.
    if(arrangementEditorMode && arrangementSegments && arrangementSegments.length > 0){
      const seg = arrangementSegments.find(s => i >= s.lineStartIdx && i < s.lineStartIdx + s.lineCount);
      if(seg) window._seqTapHlId = seg.markerId;
    }
    setCursor(t, true);
    if(usingEngine) restartEngineAt(cursorTime);
    draw();
  }
  idx.releasePointerCapture?.(ev.pointerId);
});
idx.addEventListener('pointercancel', ()=>{
  pressed=false;
  clearTimeout(qlLongTimer); qlLongTimer=null;
});

        const line = document.createElement('div'); line.className = 'line'; line.contentEditable = 'true'; line.spellcheck = false;
        line.textContent = lyrics[i] || '';
        line.addEventListener('input', ()=>{ lyrics[i] = line.textContent; });
        row.appendChild(idx); row.appendChild(line);
        lyricsListEl.appendChild(row);
      }
      applyQuickLoopClasses();

      // --- Verwaiste Zeilen (nach "Nein"-Löschen) am Ende anzeigen ---
      if(arrangementEditorMode && Array.isArray(orphanedLines) && orphanedLines.length > 0){
        const orphanSep = document.createElement('div');
        orphanSep.className = 'segmentHeader orphaned-header';
        orphanSep.textContent = '— Gelöschte Spuren (Zeilen behalten) —';
        lyricsListEl.appendChild(orphanSep);

        orphanedLines.forEach((group, groupIdx) => {
          const groupHeaderEl = document.createElement('div');
          groupHeaderEl.className = 'segmentHeader clone orphaned-subheader';
          groupHeaderEl.textContent = group.label || '–';
          lyricsListEl.appendChild(groupHeaderEl);

          group.lines.forEach((lineContent, lineJ) => {
            const row = document.createElement('div');
            row.className = 'lyricsRow orphaned';

            const delBtn = document.createElement('button');
            delBtn.className = 'btn orphaned-del';
            delBtn.title = 'Zeile löschen';
            delBtn.textContent = '✕';
            delBtn.addEventListener('click', ()=>{
              group.lines.splice(lineJ, 1);
              if(group.lines.length === 0) orphanedLines.splice(groupIdx, 1);
              renderLyricsList();
            });

            const line = document.createElement('div');
            line.className = 'line';
            line.contentEditable = 'true';
            line.spellcheck = false;
            line.textContent = lineContent;
            line.addEventListener('input', ()=>{ group.lines[lineJ] = line.textContent; });

            row.appendChild(delBtn);
            row.appendChild(line);
            lyricsListEl.appendChild(row);
          });
        });
      }
    }
    

    function rebuildLyrics({ preserve=true }={}){
      const { lines } = computeCounts();
      if(preserve){
        lyrics.length = lines; // schneidet ab oder verlängert mit leeren Einträgen
      }else{
        lyrics = new Array(lines).fill('');
      }
      renderLyricsList();
    }

// -- Default-Start/End-Marker, falls noch keine Marker existieren --
// macht beide Marker sofort AKTIV
function ensureDefaultStartEndMarkers() {
  if (!Number.isFinite(duration) || duration <= 0) return;
  if (Array.isArray(markers) && markers.length === 0) {
    const startM = { id: uid(), time: 0, label: 'Start', active: true,  pin: 'start', listOrder: 0, seqReps: 1 };
    const endM   = { id: uid(), time: duration, label: 'Ende',  active: true,  pin: 'end', listOrder: 1 };
    markers.push(startM, endM);
    reindexListOrder();
    // Sicherheitshalber konsistent halten
    markers.sort((a,b)=> (a.listOrder ?? 0) - (b.listOrder ?? 0));
    if (typeof renderMarkerList === 'function') renderMarkerList();
    if (typeof draw === 'function') draw();
    // Loop/Engine aktualisieren, falls aktiv
    if (typeof resumeWithUpdatedLoopPreservingPhase === 'function' && typeof usingEngine !== 'undefined' && usingEngine) {
      resumeWithUpdatedLoopPreservingPhase();
    }
  }
}


    function setActiveLine(idx){
      const rows = lyricsListEl.querySelectorAll('.lyricsRow');
      if(rows.length===0){ lastActiveLine = -1; return; }
      idx = Number.isFinite(idx) ? idx : -1;
      idx = (idx>=0 && idx<rows.length) ? idx : -1;
      if(lastActiveLine>=0 && rows[lastActiveLine]) rows[lastActiveLine].classList.remove('active');
      if(idx>=0 && rows[idx]) rows[idx].classList.add('active');
      lastActiveLine = idx;
      if(idx>=0 && book.classList.contains('flipped') && autoScrollEnabled){
        rows[idx].scrollIntoView({ block:'center', behavior:'smooth' });
      }
    }

    
    // --- Marker-Listen-Highlight (Original vs. Kopie in Reihenfolge) ---
    let lastActiveMarkerRowId = null;
    function setActiveMarkerRowById(id){
      try{
        const list = document.getElementById('markerList');
        if(!list) return;
        // Remove previous
        const prev = lastActiveMarkerRowId ? list.querySelector('.markerRow[data-id="'+CSS.escape(lastActiveMarkerRowId)+'"]') : null;
        if(prev) prev.classList.remove('active');
        // Set new
        if(id){
          const row = list.querySelector('.markerRow[data-id="'+CSS.escape(id)+'"]');
          if(row) row.classList.add('active');
        }
        lastActiveMarkerRowId = id || null;
      }catch(_){}
    }

    function updateMarkerRowHighlight(t){
      try{
        const list = document.getElementById('markerList');
        if(!list) return;
        const seqOn = !!(typeof playSeqOrder!=='undefined' && playSeqOrder) && !!(typeof usingEngine!=='undefined' && usingEngine) && !(window.quickLoop && window.quickLoop.active);
        let id = null;
        if(seqOn){
          // In Reihenfolge-Modus highlighten wir ausschließlich den tatsächlich gespielten Eintrag (Kopie ODER Original)
          id = (typeof seqCurrentStartId !== 'undefined') ? (seqCurrentStartId || null) : null;
        }else{
          // Ansonsten (normaler Zeitablauf / Scrubben) highlighten wir den Originalmarker des aktuellen Chrono-Segments
          const startId = (typeof findChronoSegmentStartIdAt === 'function') ? findChronoSegmentStartIdAt(t||0) : null;
          if(startId){
            const m = (typeof getMarkerById === 'function') ? getMarkerById(startId) : null;
            id = (m && m.playlistClone === true && m.playlistCloneOf) ? m.playlistCloneOf : startId;
          }
        }
        setActiveMarkerRowById(id);
      }catch(_){}
    }
function updateLyricsHighlight(t){
      if(arrangementEditorMode && arrangementSegments.length > 0){
        _updateArrangementHighlight(t);
        return;
      }
      const { lines } = computeCounts();
      if(lines<=0){ setActiveLine(-1); return; }
      const bl = barLen();
      if(!isFinite(bl) || bl<=0){ setActiveLine(-1); return; }
      const barIdx = Math.floor((t + timeTol()) / bl);
      const lineIdx = Math.floor(barIdx / 2);
      if(lineIdx !== lastActiveLine) setActiveLine(lineIdx);
    }

    function _updateArrangementHighlight(t){
      const bl = barLen();
      if(!isFinite(bl) || bl <= 0){ setActiveLine(-1); return; }

      let targetSeg = null;
      const seqOn = !!(playSeqOrder && usingEngine && !(window.quickLoop && window.quickLoop.active));

      if(seqOn && seqCurrentStartId){
        // Im Custom-Arrangement-Playback: seqCurrentStartId + Wiederholungsindex
        const state = window.__seqMonitorState || {};
        const repsLeft  = (state.id === seqCurrentStartId && state.repsLeft != null) ? state.repsLeft : null;
        const occurrences = arrangementSegments.filter(s => s.markerId === seqCurrentStartId);
        if(occurrences.length === 1){
          targetSeg = occurrences[0];
        } else if(occurrences.length > 1 && repsLeft != null){
          // repsLeft zählt abwärts: erstes Vorkommen hat höchsten repsLeft-Wert
          const totalReps = occurrences[0].totalReps;
          const repIdx    = Math.max(0, totalReps - repsLeft);
          targetSeg = occurrences.find(s => s.repIndex === repIdx) || occurrences[0];
        } else if(occurrences.length > 0){
          targetSeg = occurrences[0];
        }
      } else {
        // Kein Arrangement-Playback: Segment anhand der Audio-Zeit finden
        // Wenn ein expliziter Marker (Quick Jump oder Marker-Tap) gewählt wurde,
        // diesen bevorzugen – nötig damit Kopiespuren korrekt hervorgehoben werden.
        if(window._seqTapHlId){
          const forced = arrangementSegments.find(s => s.markerId === window._seqTapHlId && t >= s.audioStart - 1e-6 && t < s.audioEnd + 1e-6);
          if(forced) targetSeg = forced;
        }
        if(!targetSeg) targetSeg = arrangementSegments.find(s => t >= s.audioStart - 1e-6 && t < s.audioEnd + 1e-6);
        if(!targetSeg && arrangementSegments.length > 0){
          // Nächstgelegenes Segment als Fallback
          targetSeg = arrangementSegments.reduce((best, s) => {
            const d    = Math.max(s.audioStart - t, t - s.audioEnd, 0);
            const bd   = best ? Math.max(best.audioStart - t, t - best.audioEnd, 0) : Infinity;
            return d < bd ? s : best;
          }, null);
        }
      }

      if(!targetSeg){ setActiveLine(-1); return; }

      const offsetInSeg = Math.max(0, t - targetSeg.audioStart);
      const lineOffset  = Math.floor(Math.floor((offsetInSeg + timeTol()) / bl) / 2);
      const lineIdx     = targetSeg.lineStartIdx + Math.min(lineOffset, targetSeg.lineCount - 1);
      if(lineIdx !== lastActiveLine) setActiveLine(lineIdx);
    }

    // --- Zeichnen ---
    function pickTimeStep(viewSpan){
      const steps=[0.1,0.2,0.5,1,2,5,10,15,30,60,120,300,600,900,1800,3600,7200];
      for(const st of steps){ if(viewSpan/st<=10) return st; }
      return steps.at(-1);
    }

    function draw(){
      const dpr = window.devicePixelRatio||1;
      const cssW = wave.clientWidth || 340, cssH = 240;
      wave.width = Math.floor(cssW*dpr); wave.height = Math.floor(cssH*dpr);
      const ctx = wave.getContext('2d');

    // Trim Buttons
    const trimFrontBtn = document.getElementById('trimFront');
    const trimBackBtn  = document.getElementById('trimBack');
    const undoTrimBtn  = document.getElementById('undoTrim');
      ctx.setTransform(dpr,0,0,dpr,0,0);
      ctx.clearRect(0,0,cssW,cssH);
      renderHit.clear();

      const LABEL_MARGIN = 12, LABEL_H = 16;
      const topLabelY = LABEL_MARGIN;
      const bottomLabelY = cssH - LABEL_MARGIN - LABEL_H;
      const waveTop = FRAME_PAD, waveBottom = cssH - FRAME_PAD;
      const waveHeight = waveBottom - waveTop;
      const mid = waveTop + waveHeight/2;

      ctx.fillStyle='#1c1c1c'; ctx.fillRect(0,0,cssW,cssH);
      ctx.strokeStyle='#1e1e1e'; ctx.strokeRect(0.5,0.5,cssW-1,cssH-1);

      // Quick-Loop-Füllung (hat Vorrang)
      try{
        const lr = getLoopRegion();
        if(lr.mode === 'quick'){
          const left  = Math.max(0, Math.min(cssW, timeToX(lr.s, cssW)));
          const right = Math.max(0, Math.min(cssW, timeToX(lr.e, cssW)));
          if(right > left){
            ctx.fillStyle='rgba(239,68,68,0.22)';
            ctx.fillRect(left, waveTop, right-left, waveBottom - waveTop);
          }
        }
      }catch(e){ /* noop */ }


      // Waveform
      if(audioBuffer){
        const ch = audioBuffer.getChannelData(0);
        sampleRate = audioBuffer.sampleRate || sampleRate;
        const startSample = Math.floor(Math.max(0, viewStart) * sampleRate);
        const endSample = Math.min(ch.length, Math.ceil(viewEnd() * sampleRate));
        const samplesVisible = Math.max(1, endSample - startSample);
        const sppx = Math.max(1, Math.floor(samplesVisible / cssW));
        ctx.strokeStyle = '#546e7a';
        ctx.beginPath();
        for(let x=0;x<cssW;x++){
          const s0 = startSample + x * sppx;
          let min = 1, max = -1;
          for(let i=0;i<sppx && (s0+i)<endSample;i++){
            const v = ch[s0+i]||0; if(v<min) min=v; if(v>max) max=v;
          }
          ctx.moveTo(x, mid + min*(waveHeight/2-10));
          ctx.lineTo(x, mid + max*(waveHeight/2-10));
        }
        ctx.stroke();
      }

      // Zeitachse (unten)
      if(duration>0 && viewDur>0){
        const step=pickTimeStep(viewDur);
        const minor=step/5;
        const startMajor = Math.ceil(viewStart/step)*step;
        const startMinor = Math.ceil(viewStart/minor)*minor;

        ctx.strokeStyle='rgba(255,255,255,0.10)';
        for(let t=startMinor; t<=viewEnd()+EPS; t+=minor){
          if(Math.abs((t/step) - Math.round(t/step)) < 1e-6) continue;
          const x = timeToX(t, cssW);
          ctx.beginPath(); ctx.moveTo(x, waveBottom-8); ctx.lineTo(x, waveBottom-3); ctx.stroke();
        }

        ctx.strokeStyle='rgba(255,255,255,0.20)';
        ctx.fillStyle='rgba(224,224,224,0.95)';
        ctx.font='11px ui-monospace, SFMono-Regular, Menlo, monospace';
        for(let t=startMajor; t<=viewEnd()+EPS; t+=step){
          const x = timeToX(t, cssW);
          ctx.beginPath(); ctx.moveTo(x, waveBottom-14); ctx.lineTo(x, waveBottom-3); ctx.stroke();
          const lbl = shortTimeLabel(t);
          const w = ctx.measureText(lbl).width;
          const tx = Math.min(Math.max(x - w/2, 2), cssW - w - 2);
          ctx.fillText(lbl, tx, waveBottom - 16);
        }
      }

      // Raster (2-Takt-Linien, Snap)
      const stepGrid = gridStep();
      if(duration>0 && stepGrid>0){
        ctx.strokeStyle='rgba(92,158,255,0.25)';
        const t0 = Math.ceil((viewStart - EPS) / stepGrid) * stepGrid;
        for(let t=t0; t<=viewEnd()+EPS; t+=stepGrid){
          const x = timeToX(t, cssW);
          ctx.beginPath(); ctx.moveTo(x, waveTop); ctx.lineTo(x, waveBottom); ctx.stroke();
        }
      }

      // Loop-Füllung
      const act = getActiveMarkersSorted();
      if(act.length===2){
        const s=Math.min(act[0].time,act[1].time), e=Math.max(act[0].time,act[1].time);
        const left = Math.max(0, Math.min(cssW, timeToX(s, cssW)));
        const right = Math.max(0, Math.min(cssW, timeToX(e, cssW)));
        if(right>left){
          ctx.fillStyle='rgba(92,158,255,0.18)';
          ctx.fillRect(left, waveTop, right-left, waveBottom - waveTop);
        }
      }

      // Marker + Beschriftungen
      if(markers.length>0 && duration>0){
        ctx.font='11px ui-monospace, SFMono-Regular, Menlo, monospace';
        const sorted = markers.filter(m=>!m.playlistClone).slice().sort((a,b)=>a.time-b.time);
        const visible=sorted.filter(m=>m.time>=viewStart-EPS && m.time<=viewEnd()+EPS);
        visible.forEach(m=>{
          const idx=sorted.findIndex(mm=>mm.id===m.id);
          const labelTop=(idx%2===0);
          const x=timeToX(m.time, cssW);
          const color = m.active ? 'rgba(239,68,68,0.95)' : 'rgba(92,158,255,0.95)';
          ctx.strokeStyle=color; ctx.beginPath(); ctx.moveTo(x, waveTop); ctx.lineTo(x, waveBottom); ctx.stroke();

          const txt=(m.label||'').slice(0,80);
          const pad=3, h=16, w=ctx.measureText(txt).width+pad*2;
          const lx=Math.min(Math.max(x-w/2,2), cssW-w-2);
          const ly=labelTop?12:(cssH-12-16);
          ctx.fillStyle='rgba(17,17,17,0.9)'; ctx.fillRect(lx,ly,w,h);
          ctx.strokeStyle=color; ctx.strokeRect(lx,ly,w,h);
          ctx.fillStyle='#e0e0e0'; ctx.fillText(txt, lx+pad, ly+12);
          ctx.strokeStyle=color; ctx.beginPath();
          if(labelTop){ ctx.moveTo(x, ly+h); ctx.lineTo(x, waveTop); } else { ctx.moveTo(x, ly); ctx.lineTo(x, waveBottom); }
          ctx.stroke();
          renderHit.set(m.id, { x, labelRect:{x:lx,y:ly,w,h} });
        });
      }

      // Cursor
      const cx = timeToX(cursorTime, cssW);
      if(cx>=0 && cx<=cssW){
        ctx.fillStyle='rgba(255,255,255,0.7)';
        ctx.fillRect(cx, waveTop, 2, waveBottom - waveTop);
        const handleY = waveTop - 12;
        ctx.beginPath(); ctx.arc(cx, handleY, 7, 0, Math.PI*2);
        ctx.fillStyle='#e0e0e0'; ctx.fill();
        ctx.beginPath(); ctx.moveTo(cx, handleY+6); ctx.lineTo(cx-6, handleY+12); ctx.lineTo(cx+6, handleY+12); ctx.closePath();
        ctx.fillStyle = '#e0e0e0'; ctx.fill();
      }

      // Auch im Pause-/Scrub-Zustand Zeilen-Highlight aktualisieren
      updateLyricsHighlight(cursorTime);
      updateMarkerRowHighlight(cursorTime);
    }

    // --- Cursor setzen (Snap bleibt) ---
    function setCursor(t, snapIt=true){
      const step = gridStep();
      const doSnap = !!snapIt && !!(typeof snapEnabled!=='undefined' ? snapEnabled : true);
      const target = doSnap ? Math.round(t/step)*step : t;
      cursorTime = clamp(target, 0, duration||0);
      curLabel.textContent = formatTime(cursorTime);
    }

    // --- Interaktion (Drag Cursor / Pan / Pinch) + Marker UI ---
    function hitMarkerLabel(ev){
      const rect = wave.getBoundingClientRect();
      const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
      for(const m of markers){
        const hit = renderHit.get(m.id); if(!hit) continue;
        const r = hit.labelRect;
        if(px>=r.x && px<=r.x+r.w && py>=r.y && py<=r.y+r.h) return m;
      }
      return null;
    }

    wave.addEventListener('pointerdown', (ev)=>{
      if(duration<=0) return;
      wave.setPointerCapture(ev.pointerId);
      activePointers.set(ev.pointerId,{x:ev.clientX,y:ev.clientY});
      // Tap-Kandidat vormerken
      downX = ev.clientX; downY = ev.clientY; tapCandidate = true;
      tapOnMarkerLabel = false;

      const rect=wave.getBoundingClientRect();
      const x=clamp(ev.clientX-rect.left,0,rect.width);
      const y=clamp(ev.clientY-rect.top,0,rect.height);
      const cx=timeToX(cursorTime, rect.width);
      const overHandle=(Math.abs(x-cx)<=14) && (y<=FRAME_PAD);

      if(activePointers.size===2){
        const pts=[...activePointers.values()];
        const dx=pts[1].x-pts[0].x, dy=pts[1].y-pts[0].y;
        pinchStartDist=Math.hypot(dx,dy); pinchStartViewDur=viewDur;
        const midX=(pts[0].x+pts[1].x)/2-rect.left; pinchCenterTime=xToTime(midX,rect.width);
        draggingCursor=false; draggingPan=false; clearTimeout(longTimer); longTimer=null; draggingMarkerId=null;
        return;
      }

      const m=hitMarkerLabel(ev);
      if(m){
        tapOnMarkerLabel = true;
        const startX=ev.clientX;
        longTimer=setTimeout(()=>{ draggingMarkerId=m.id; },300);
        const now=Date.now();
        const isDouble=(lastTapId===m.id && tapTimer && (now - tapTimer.time) < 300);
        if(isDouble){
          clearTimeout(tapTimer.handle); tapTimer=null; lastTapId=null;
          const name=prompt('Neuer Markername:', m.label||''); if(name!==null){ m.label=name; renderMarkerList(); draw(); }
        }else{
          tapTimer={ time:now, handle:setTimeout(()=>{
            m.active=!m.active; if(m.active) ensureMaxTwoActive(m);
            // Falls ein manuell erstellter Marker aktiviert wird, Start/End-Marker deaktivieren
            if(m.active && !m.pin) {
              markers.forEach(x => { if(x.pin === 'start' || x.pin === 'end') x.active = false; });
            }
            const act=markers.filter(x=>x.active).sort((a,b)=>a.time-b.time);
            if(act.length>2){ for(let i=2;i<act.length;i++) act[i].active=false; }
            renderMarkerList(); draw();
            if(usingEngine) resumeWithUpdatedLoopPreservingPhase();
            tapTimer=null; lastTapId=null;
          },320) }; lastTapId=m.id;
        }

        function onMove(e){
          if(draggingMarkerId===m.id){
            const rect=wave.getBoundingClientRect();
            const xx=clamp(e.clientX-rect.left,0,rect.width);
            const t=xToTime(xx,rect.width);
            m.time=clamp(snapToGrid(t),0,duration);
            markers.sort((a,b)=> (a.listOrder ?? 0) - (b.listOrder ?? 0));
            renderMarkerList(); draw();
            if(usingEngine && m.active) resumeWithUpdatedLoopPreservingPhase();
          }else{
            if(Math.abs(e.clientX-startX)>8){ clearTimeout(longTimer); longTimer=null; }
          }
        }
        function onUp(e){
          clearTimeout(longTimer); longTimer=null;
          if(draggingMarkerId===m.id){ draggingMarkerId=null; if(usingEngine) resumeWithUpdatedLoopPreservingPhase(); }
          wave.removeEventListener('pointermove', onMove);
          wave.removeEventListener('pointerup', onUp);
          wave.releasePointerCapture?.(e.pointerId);
        }
        wave.addEventListener('pointermove', onMove);
        wave.addEventListener('pointerup', onUp);
        return;
      }

      if(overHandle){ draggingCursor=true; draggingPan=false; clearTimeout(longTimer); longTimer=null; draggingMarkerId=null; return; }

      draggingPan=true; draggingCursor=false; clearTimeout(longTimer); longTimer=null; draggingMarkerId=null;
      panStartX=ev.clientX; panStartViewStart=viewStart;
    });

    wave.addEventListener('pointermove', (ev)=>{
      if(!activePointers.has(ev.pointerId)) return;
      activePointers.set(ev.pointerId,{x:ev.clientX,y:ev.clientY});
      const rect=wave.getBoundingClientRect();

      if(activePointers.size===1){
        if(draggingCursor){
          const x=clamp(ev.clientX-rect.left,0,rect.width);
          const t=xToTime(x,rect.width);
          setCursor(t,true);
          if(usingEngine) restartEngineAt(cursorTime);
          draw();
        } else if(draggingPan){
          const dx=ev.clientX-panStartX;
          const dt=(dx/rect.width)*viewDur;
          const newStart=clamp(panStartViewStart - dt, 0, Math.max(0, duration - viewDur));
          setView(newStart, viewDur);
          draw();
        }
      } else if(activePointers.size===2){
        const pts=[...activePointers.values()];
        const dx=pts[1].x-pts[0].x, dy=pts[1].y-pts[0].y;
        const dist=Math.hypot(dx,dy);
        const scale=(pinchStartDist>0)?(dist/pinchStartDist):1;
        let newDur=clamp(pinchStartViewDur/scale, Math.min(gridStep()/4, duration||1), duration||1);
        const midX=(pts[0].x+pts[1].x)/2-rect.left;
        const newStart=clamp(pinchCenterTime - (midX/rect.width)*newDur, 0, Math.max(0, (duration||0) - newDur));
        setView(newStart, newDur);
        draw();
      }
    });

    function endPointer(ev){
      activePointers.delete(ev.pointerId);
      // Tap-to-seek: wenn es ein echter Tap war (kein Drag, kein Marker, kein Pan)
      if(activePointers.size===0){
        const rect = wave.getBoundingClientRect();
        const upX = clamp(ev.clientX - rect.left, 0, rect.width);
        const upY = clamp(ev.clientY - rect.top, 0, rect.height);
        const isInWaveform = (upY >= FRAME_PAD) && (upY <= rect.height - FRAME_PAD);
        const maySeek = tapCandidate && !draggingCursor && !draggingMarkerId && !tapOnMarkerLabel && !isInWaveform;
        if(maySeek){
          const t = xToTime(upX, rect.width);
          setCursor(t, true);
          if(usingEngine) restartEngineAt(cursorTime);
          draw();
        }
        tapCandidate = false;
      }

      if(activePointers.size===0){
        if(draggingCursor){ setCursor(cursorTime, true); }
        draggingCursor=false; draggingPan=false; draggingMarkerId=null; pinchStartDist=0;
        draw();
      }
      wave.releasePointerCapture?.(ev.pointerId);
    }
    wave.addEventListener('pointerup', endPointer);
    wave.addEventListener('pointercancel', endPointer);

    // Desktop Zoom per Ctrl+Wheel
    wave.addEventListener('wheel', (ev)=>{
      if(duration<=0) return;
      if(!ev.ctrlKey) return;
      ev.preventDefault();
      const rect=wave.getBoundingClientRect();
      const mouseX=clamp(ev.clientX-rect.left,0,rect.width);
      const anchorTime=xToTime(mouseX,rect.width);
      const factor=Math.exp(-ev.deltaY*0.0015);
      const targetDur=clamp(viewDur * (1/factor), Math.min(gridStep()/4, duration||1), duration||1);
      const newStart=clamp(anchorTime - targetDur*((mouseX/rect.width)), 0, Math.max(0, duration - targetDur));
      setView(newStart, targetDur); draw();
    }, { passive:false });

    
    // --- Projekt speichern/laden (+ Lyrics) ---
    function currentProject(){
      // Serialize *all* marker properties that matter for restoring the UI/logic
      const mm = (Array.isArray(markers) ? markers : []).map((m,i)=> ({
        id: m.id || uid(),
        time: +m.time || 0,
        label: (m.label || ''),
        active: !!m.active,
        // arrangement / ordering
        listOrder: Number.isFinite(m.listOrder) ? +m.listOrder : i,
        // optional flags/fields
        pin: (m.pin || undefined),
        seqReps: Number.isFinite(m.seqReps) ? Math.max(0, Math.floor(m.seqReps)) : (m.playlistClone === true ? 1 : 1),
        muted: (m.muted === true),
        playlistClone: (m.playlistClone === true),
        playlistCloneOf: (m.playlistCloneOf || undefined),
        note: (typeof m.note === 'string' ? m.note : undefined)
      }));
      return {
        version: 22,
        timeSig: beatsPerBar,
        bpm: bpm(),
        cursorTime,
        markers: mm,
        viewStart, viewDur,
        lyrics: Array.isArray(lyrics) ? lyrics.slice() : [],
        relativeAudio: relativeAudioName || (loadedFileMeta ? loadedFileMeta.name : null),
        file: loadedFileMeta || null,
        createdAt: new Date().toISOString(),
        playSeqOrder: !!playSeqOrder,
        markerTimeBase: 'trimmed',
        trim: {
          start: Number.isFinite(projectTrim.start) ? projectTrim.start : 0,
          end: Number.isFinite(projectTrim.end) ? projectTrim.end : (duration||0)
        },
        pitchSt: pitchSt,
        playbackTempoBpm: playbackTempoBpm,
        arrangementEditorMode: !!arrangementEditorMode,
        // Lyrics per segKey speichern – stabile Marker-ID-Zuordnung, unabhängig von Position
        arrangementLyrics: (arrangementEditorMode && arrangementSegments.length > 0) ? (()=>{
          const out = {};
          for(const seg of arrangementSegments){
            out[seg.segKey] = lyrics.slice(seg.lineStartIdx, seg.lineStartIdx + seg.lineCount);
          }
          return out;
        })() : null,
        orphanedLines: Array.isArray(orphanedLines) ? orphanedLines.map(g=>({ label: g.label, lines: g.lines.slice() })) : []
      };
    }

    function downloadJson(obj,filename){
      const blob=new Blob([JSON.stringify(obj,null,2)],{type:'application/json'});
      const url=URL.createObjectURL(blob); const a=document.createElement('a');
      a.href=url; a.download=filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),1500);
    }

    saveProjectBtn?.addEventListener('click', ()=>{
      const defaultBase = (loadedFileMeta && loadedFileMeta.name ? loadedFileMeta.name.replace(/\.[^.]+$/, '') : 'projekt');
      let name = prompt('Vergib einen Projektnamen und wähle danach den gewünschten Ordner', `${defaultBase}_session`);
      if(name===null) return;
      name = (name.trim() || 'projekt');
      if(!/\.json$/i.test(name)) name += '.json';
      const data = JSON.stringify(currentProject());
      if (window.Android && Android.saveProject) {
        try { Android.saveProject(data, name); }
        catch(e){ alert('Konnte Android-Dateiauswahl nicht öffnen: '+e); }
      } else {
        downloadJson(currentProject(), name);
      }
    });loadProjectInput?.addEventListener('change', async e=>{
      const f=e.target.files&&e.target.files[0]; if(!f) return;
      try{
        const txt=await f.text(); const json=JSON.parse(txt);
        
        // Stash project JSON until audio is selected
        try{ pendingProject = json || null; }catch(_){ pendingProject = null; }
        // Arrangement-Wiederherstellungsdaten separat speichern (unabhängig von pendingProject)
        _arrangementRestoreData = (json.arrangementEditorMode === true && json.arrangementLyrics && typeof json.arrangementLyrics === 'object')
          ? { lyrics: json.arrangementLyrics }
          : null;
        try{ loadedProjectMarkerBase = (json && json.markerTimeBase === 'original') ? 'original' : 'trimmed'; }catch(_){ loadedProjectMarkerBase = 'trimmed'; }
        // Preload trim info (seconds in original timeline)
        try{
          if(json && json.trim){
            projectTrim.start = Number.isFinite(json.trim.start) ? json.trim.start : 0;
            projectTrim.end   = Number.isFinite(json.trim.end)   ? json.trim.end   : null;
          }else{
            projectTrim = { start: 0, end: null };
          }
        }catch(_){ projectTrim = { start: 0, end: null }; }

        
        // Reihenfolge-Playback Flag laden
        playSeqOrder = !!json.playSeqOrder;
        if (typeof playSeqToggle !== 'undefined' && playSeqToggle) playSeqToggle.checked = playSeqOrder;
bpmInput.value = json.bpm || 120;
        

        // Load time signature (default 4/4)
        try {
          beatsPerBar = (json.timeSig === 3 ? 3 : 4);
          if (typeof timeSigSelect !== 'undefined' && timeSigSelect) timeSigSelect.value = String(beatsPerBar);
          // Update minView based on new grid and re-clamp the view
          minView = Math.max(0.25, gridStep()/4);
          setView(viewStart, viewDur || (duration||0));
        } catch(_) {}

cursorTime = +json.cursorTime || 0;
        
        markers = Array.isArray(json.markers) ? json.markers.map((m,i)=>({
          id: m.id || uid(),
          time: +m.time || 0,
          label: (m.label || ''),
          active: !!m.active,
          listOrder: Number.isFinite(m.listOrder) ? +m.listOrder : i,
          // optional (keine Pflicht im alten Format)
          pin: (m.pin || undefined),
          seqReps: Number.isFinite(m.seqReps) ? Math.max(0, Math.floor(m.seqReps)) : 1,
          muted: (m.muted === true),
          playlistClone: (m.playlistClone === true),
          playlistCloneOf: (m.playlistCloneOf || undefined),
          note: (typeof m.note === 'string' ? m.note : undefined)
        })) : [];

        markers.sort((a,b)=> (a.listOrder ?? 0) - (b.listOrder ?? 0));
        const vs = Number.isFinite(json.viewStart)? +json.viewStart : 0;
        const vd = Number.isFinite(json.viewDur) && json.viewDur>0 ? +json.viewDur : (duration||0);
        setView(vs, vd>0?vd:(duration||0));

        // Arrangement-Editor-Modus zurücksetzen – wird nach Audio-Decode wiederhergestellt
        arrangementEditorMode = false; arrangementSegments = [];
        try{ if(importMarkersBtn) importMarkersBtn.classList.remove('active'); }catch(_){}

        // Lyrics laden (werden nach Audio-Decode auf richtige Länge gebracht)
        lyrics = Array.isArray(json.lyrics) ? json.lyrics.slice() : [];
        // Verwaiste Zeilen wiederherstellen
        orphanedLines = Array.isArray(json.orphanedLines)
          ? json.orphanedLines.map(g=>({ label: String(g.label||''), lines: Array.isArray(g.lines) ? g.lines.map(String) : [] })).filter(g=>g.lines.length>0)
          : [];
        renderLyricsList();

        renderMarkerList(); draw();

        // --- Auto-activate "Marker übernehmen" on project load ---
        try{
          perSegmentLineNumbering = true;
          const blAuto = barLen();
          if(isFinite(blAuto) && blAuto > 0){
            const headersAuto = [];
            (markers||[])
              .filter(m=> (m.label||'').trim().length>0 && m.playlistClone !== true)
              .forEach(m=>{
                const barNumber = Math.floor((m.time + timeTol()) / blAuto) + 1; // 1-basiert
                const lineIdx   = Math.floor((barNumber - 1) / 2) + 1;     // 2 Takte pro Zeile
                headersAuto.push({ lineIdx, label: m.label.trim(), bar: barNumber });
              });
            headersAuto.sort((a,b)=> a.lineIdx - b.lineIdx || a.bar - b.bar);
            markerHeaders = headersAuto;
          }else{
            perSegmentLineNumbering = false;
            markerHeaders = [];
          }
          renderLyricsList();
        }catch(e){ /* noop */ }


        alert('Lade nun die passende Audiodatei');}catch(err){ alert('Konnte Projekt nicht lesen: '+(err&&err.message?err.message:err)); }
      e.target.value='';
    });

    loadAudioForProject?.addEventListener('change', async (e)=>{
      const file=e.target.files&&e.target.files[0]; if(!file) return;
      _showPitchLoadingUI(true);
      try{
        const arrayBuf=await file.arrayBuffer();
        audioBuffer=await getDecodeAC().decodeAudioData(arrayBuf);
        duration=audioBuffer.duration; sampleRate=audioBuffer.sampleRate;
        pitchedBuffer = null; pitchSt = 0; try{ updatePitchUI(); }catch(_){} playbackTempoBpm = null; try{ updateTempoUI(); }catch(_){}

        // Pitch- und Temposhift aus dem Projekt wiederherstellen
        try{
          if(pendingProject && Number.isFinite(pendingProject.pitchSt) && pendingProject.pitchSt !== 0){
            pitchSt = Math.max(-24, Math.min(24, Math.round(pendingProject.pitchSt)));
            updatePitchUI();
          }
          if(pendingProject && pendingProject.playbackTempoBpm !== null && Number.isFinite(pendingProject.playbackTempoBpm)){
            playbackTempoBpm = Math.max(1, Math.min(999.5, pendingProject.playbackTempoBpm));
            updateTempoUI();
          }
        }catch(_){}

        if(objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl=URL.createObjectURL(file);
        loadedFileMeta={ name:file.name, size:file.size, type:file.type||'', lastModified:file.lastModified||0 };
        relativeAudioName=file.name;
        fileInfo.textContent = file.name || '–';
        if(viewDur===0){ setView(0, duration); }
        draw();
        // Nach dem Laden Zeilen ggf. neu erzeugen (bestehende Texte werden erhalten)
        rebuildLyrics({ preserve:true });

        // Apply persisted trim from project (if provided)
        try{
          if(pendingProject && pendingProject.trim){
            projectTrim.start = Number.isFinite(pendingProject.trim.start) ? pendingProject.trim.start : 0;
            projectTrim.end   = Number.isFinite(pendingProject.trim.end)   ? pendingProject.trim.end   : (audioBuffer.duration||0);
            const sliced = applyProjectTrimOnBuffer(audioBuffer);
            if(sliced){
              audioBuffer = sliced;
              duration = audioBuffer.duration || duration;
              // Ensure start/end pins
              let sM = markers.find(m=>m.pin==='start'); let eM = markers.find(m=>m.pin==='end');
              if(!sM || !eM){
                markers = (markers||[]).filter(m=>!m.pin);
                markers.unshift({ id: uid(), time: 0, label: 'Start', active: true, pin:'start', listOrder: 0, seqReps:1 });
                markers.push({ id: uid(), time: duration, label: 'Ende', active: true, pin:'end', listOrder: (markers.length) });
              }else{ sM.time = 0; eM.time = duration; }
              // Reset view
              minView = Math.max(0.25, gridStep()/4);
              setView(0, Math.max(minView, Math.min(viewDur||duration, duration)));
              draw();
            
              // Rebuild lyrics after trim has changed duration
              rebuildLyrics({ preserve:true });
}
          }else{
            // Default: no trim (full file)
            projectTrim.start = 0;
            projectTrim.end = audioBuffer.duration||0;
          }
        }catch(_){}


        try { if (timeSigSelect) timeSigSelect.value = String(beatsPerBar); } catch(_) {}
// auto-marker
ensureDefaultStartEndMarkers();

        // Arrangement-Editor-Modus aus Projekt wiederherstellen
        try{
          if(_arrangementRestoreData && _arrangementRestoreData.lyrics){
            const segs = buildArrangementForEditor();
            if(segs.length > 0){
              const totalLines = segs[segs.length - 1].lineStartIdx + segs[segs.length - 1].lineCount;
              const newLyrics  = new Array(totalLines).fill('');
              for(const seg of segs){
                const segLines = _arrangementRestoreData.lyrics[seg.segKey] || [];
                for(let j = 0; j < Math.min(seg.lineCount, segLines.length); j++){
                  newLyrics[seg.lineStartIdx + j] = segLines[j] || '';
                }
              }
              lyrics              = newLyrics;
              arrangementSegments = segs;
              arrangementEditorMode = true;
              perSegmentLineNumbering = true;
              try{ if(importMarkersBtn) importMarkersBtn.classList.add('active'); }catch(_){}
              renderLyricsList();
            }
          }
          _arrangementRestoreData = null;
        }catch(_){ _arrangementRestoreData = null; }

        // Wenn Pitch/Tempo aus dem Projekt abweichen, async verarbeiten und
        // Spinner laufen lassen – sonst sofort ausblenden.
        try{ _triggerPitchTempoAsync(); }catch(_){}
        if(!_pitchPending) _showPitchLoadingUI(false);
      }catch(err){ _showPitchLoadingUI(false); alert('Konnte Audiodatei nicht laden: '+(err&&err.message?err.message:err)); }
    });

    // --- Datei laden ---
    fileInput.addEventListener('change', async e=>{
      const file=e.target.files&&e.target.files[0]; if(!file) return;
      if(objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl=URL.createObjectURL(file);
      loadedFileMeta={ name:file.name, size:file.size, type:file.type||'', lastModified:file.lastModified||0 };
      relativeAudioName=file.name;
      fileInfo.textContent = file.name || '–';
      audioBuffer=null; duration=0; draw();
      _showPitchLoadingUI(true);
      try{
        const arrayBuf=await file.arrayBuffer();
        audioBuffer=await getDecodeAC().decodeAudioData(arrayBuf);
        duration=audioBuffer.duration; sampleRate=audioBuffer.sampleRate;
        pitchedBuffer = null; pitchSt = 0; try{ updatePitchUI(); }catch(_){} playbackTempoBpm = null; try{ updateTempoUI(); }catch(_){}
        // Neue Datei → Arrangement-Editor-Modus zurücksetzen
        arrangementEditorMode = false; arrangementSegments = [];
        try{ if(importMarkersBtn) importMarkersBtn.classList.remove('active'); }catch(_){}

        minView=Math.max(0.25, gridStep()/4);
        setView(0, duration);
        draw();
        // Nach dem Laden Zeilen neu berechnen
        rebuildLyrics({ preserve:true });

        
// Apply persisted trim when loading audio after a project (or default to full file)
try{
  if(pendingProject && pendingProject.trim){
    projectTrim.start = Number.isFinite(pendingProject.trim.start) ? pendingProject.trim.start : 0;
    projectTrim.end   = Number.isFinite(pendingProject.trim.end)   ? pendingProject.trim.end   : (audioBuffer.duration||0);
    const sliced = applyProjectTrimOnBuffer(audioBuffer);
    if(sliced){
      audioBuffer = sliced;
      duration = audioBuffer.duration || duration;
      // Ensure start/end pins
      let sM = markers.find(m=>m.pin==='start'); let eM = markers.find(m=>m.pin==='end');
      if(!sM || !eM){
        markers = (markers||[]).filter(m=>!m.pin);
        markers.unshift({ id: uid(), time: 0, label: 'Start', active: true, pin:'start', listOrder: 0, seqReps:1 });
        markers.push({ id: uid(), time: duration, label: 'Ende', active: true, pin:'end', listOrder: (markers.length) });
      }else{ sM.time = 0; eM.time = duration; }
      // Reset view
      minView = Math.max(0.25, gridStep()/4);
      setView(0, Math.max(minView, Math.min(viewDur||duration, duration)));
      draw();
    
              // Rebuild lyrics after trim has changed duration
              rebuildLyrics({ preserve:true });
}
  }else{
    // Default: no trim (full file)
    projectTrim.start = 0;
    projectTrim.end = audioBuffer.duration||0;
  }
}catch(_){}
// Pitch- und Temposhift aus dem Projekt wiederherstellen (vor pendingProject = null)
try{
  if(pendingProject && Number.isFinite(pendingProject.pitchSt) && pendingProject.pitchSt !== 0){
    pitchSt = Math.max(-24, Math.min(24, Math.round(pendingProject.pitchSt)));
    updatePitchUI();
  }
  if(pendingProject && pendingProject.playbackTempoBpm !== null && Number.isFinite(pendingProject.playbackTempoBpm)){
    playbackTempoBpm = Math.max(1, Math.min(999.5, pendingProject.playbackTempoBpm));
    updateTempoUI();
  }
}catch(_){}
try{ pendingProject = null; }catch(_){}
// auto-marker

ensureDefaultStartEndMarkers();
        // Arrangement-Editor-Modus aus Projekt wiederherstellen (falls Projekt über fileInput geladen)
        try{
          if(_arrangementRestoreData && _arrangementRestoreData.lyrics){
            const segs = buildArrangementForEditor();
            if(segs.length > 0){
              const totalLines = segs[segs.length - 1].lineStartIdx + segs[segs.length - 1].lineCount;
              const newLyrics  = new Array(totalLines).fill('');
              for(const seg of segs){
                const segLines = _arrangementRestoreData.lyrics[seg.segKey] || [];
                for(let j = 0; j < Math.min(seg.lineCount, segLines.length); j++){
                  newLyrics[seg.lineStartIdx + j] = segLines[j] || '';
                }
              }
              lyrics              = newLyrics;
              arrangementSegments = segs;
              arrangementEditorMode = true;
              perSegmentLineNumbering = true;
              try{ if(importMarkersBtn) importMarkersBtn.classList.add('active'); }catch(_){}
              renderLyricsList();
            }
          }
          _arrangementRestoreData = null;
        }catch(_){ _arrangementRestoreData = null; }
        // Wenn Pitch/Tempo aus dem Projekt abweichen, async verarbeiten und
        // Spinner laufen lassen – sonst sofort ausblenden.
        try{ _triggerPitchTempoAsync(); }catch(_){}
        if(!_pitchPending) _showPitchLoadingUI(false);
      }catch(err){ _showPitchLoadingUI(false); console.warn('Decode fehlgeschlagen:',err); draw(); }
    });

    // --- Marker-Liste ---
    function renderMarkerList(){
  markerListEl.innerHTML = "";
  ensureListOrder();
  if(markers.length===0){
    markerListEl.innerHTML = '<div style="color:#9e9e9e;">Noch keine Marker.</div>';
    return;
  }
  const ordered = markers.slice().sort((a,b)=> (a.listOrder ?? 0) - (b.listOrder ?? 0));

  // Delegated container-level handlers (set up once)
  if(!markerListEl._dndBound){
    let dragId = null;
    let overRow = null;
    let overPos = null; // "before" | "after"

    markerListEl.addEventListener('dragstart', (e)=>{
      const row = e.target.closest('.markerRow');
      if(!row) return e.preventDefault();
      // only allow dragging when starting from handle
      if(!e.target.closest('.dragHandle')) return e.preventDefault();
      dragId = row.dataset.id;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try{ e.dataTransfer.setData('text/plain', dragId); }catch(_){}
    
      // Custom drag image for better feel
      try {
        const ghost = row.cloneNode(true);
        ghost.style.width = row.offsetWidth + 'px';
        ghost.style.position = 'absolute';
        ghost.style.top = '-9999px';
        ghost.style.left = '-9999px';
        ghost.style.opacity = '0.85';
        document.body.appendChild(ghost);
        e.dataTransfer.setDragImage(ghost, ghost.offsetWidth/2, ghost.offsetHeight/2);
        setTimeout(()=>{ try { document.body.removeChild(ghost); } catch(_){} }, 0);
      } catch(_){}
    });

    markerListEl.addEventListener('dragend', (e)=>{
      const row = e.target.closest('.markerRow');
      if(row) row.classList.remove('dragging');
      dragId = null;
      if(overRow){ overRow.classList.remove('drop-before','drop-after','drop-target'); overRow=null; }
      overPos = null;
    });

    markerListEl.addEventListener('dragover', (e)=>{
      e.preventDefault();
      const row = e.target.closest('.markerRow');
      if(!row) return;
      if(overRow && overRow !== row){ overRow.classList.remove('drop-before','drop-after','drop-target'); }
      overRow = row;
      row.classList.add('drop-target');
      const rect = row.getBoundingClientRect();
      const halfway = rect.top + rect.height/2;
      const pos = (e.clientY < halfway) ? 'after' : 'before';
      overPos = pos;
      row.classList.toggle('drop-before', pos==='before');
      row.classList.toggle('drop-after',  pos==='after');
      e.dataTransfer.dropEffect = 'move';
    });

    markerListEl.addEventListener('drop', (e)=>{
      e.preventDefault();
      const row = e.target.closest('.markerRow');
      if(!row || !dragId) return;
      const targetId = row.dataset.id;
      const list = markers.slice().sort((a,b)=> (a.listOrder ?? 0) - (b.listOrder ?? 0));
      const from = list.findIndex(m=>m.id===dragId);
      const toBase = list.findIndex(m=>m.id===targetId);
      if(from<0 || toBase<0) return;
      const to = overPos === 'before' ? toBase : toBase+1;
      reorderById(dragId, to>from ? to-1 : to);
      renderMarkerList();
      draw();
      if(usingEngine) resumeWithUpdatedLoopPreservingPhase();
    });

    
    // --- Touch/Pen Fallback: Sortieren per Griffpunkt mit Pointer-Events ---
    markerListEl.addEventListener('pointerdown', (e)=>{
      const handle = e.target.closest('.dragHandle');
      if(!handle) return;                      // nur am Griff
      e.preventDefault();

      const row = handle.closest('.markerRow');
      if(!row) return;

      // Nativen HTML5-Drag deaktivieren, damit er nicht mit Pointer-Events kollidiert
      row.draggable = false;

      const dragIdLocal = row.dataset.id;
      let overRow = null;
      let overPos = null; // 'before' | 'after'

      row.classList.add('dragging');

      function onMove(ev){
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        const targetRow = el && el.closest ? el.closest('.markerRow') : null;

        if(overRow && overRow !== targetRow){
          overRow.classList.remove('drop-before','drop-after','drop-target');
        }
        if(targetRow && targetRow !== row){
          const r = targetRow.getBoundingClientRect();
          const halfway = r.top + r.height/2;
          overPos = (ev.clientY < halfway) ? 'after' : 'before';
          targetRow.classList.add('drop-target');
          targetRow.classList.toggle('drop-before', overPos === 'before');
          targetRow.classList.toggle('drop-after',  overPos === 'after');
        }else{
          overPos = null;
        }
        overRow = targetRow || null;
      }

      function onUp(){
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        row.classList.remove('dragging');
        row.draggable = true; // Nativen Drag wiederherstellen

        if(overRow && overPos){
          const list = markers.slice().sort((a,b)=> (a.listOrder ?? 0) - (b.listOrder ?? 0));
          const from = list.findIndex(m=> m.id === dragIdLocal);
          const toBase = list.findIndex(m=> m.id === overRow.dataset.id);
          if(from >= 0 && toBase >= 0){
            const to = (overPos === 'before') ? toBase : toBase + 1;
            reorderById(dragIdLocal, to > from ? to - 1 : to);
          }
          overRow.classList.remove('drop-before','drop-after','drop-target');
          renderMarkerList(); 
          if (typeof draw === 'function') { try { draw(); } catch(e){} }
          if (typeof usingEngine !== 'undefined' && usingEngine && typeof resumeWithUpdatedLoopPreservingPhase === 'function') {
            try { resumeWithUpdatedLoopPreservingPhase(); } catch(e){}
          }
        }
      }

      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp, { once:true });
    });
    markerListEl._dndBound = true;
  }

  ordered.forEach((m)=>{
    const row = document.createElement('div');
    row.className = 'markerRow';
    row.dataset.id = m.id;
    row.draggable = true;
    try{ row.classList.toggle('muted', !!(m && m.muted && !m.playlistClone)); }catch(_){}

    const handle = document.createElement('div');
    handle.className = 'dragHandle';
    handle.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M5 7h14M5 12h14M5 17h14" stroke="#9e9e9e" stroke-width="1.8" stroke-linecap="round"/></svg>';

    const name = document.createElement('input');
    name.className='field'; name.type='text'; name.value=m.label||''; name.placeholder='Markername';
    name.addEventListener('change', ()=>{ m.label=name.value; draw(); });

    
    
    
    // kleine Badge für Kopien
    if(m.playlistClone === true){
      const badge = document.createElement('div');
      badge.className = 'mono';
      badge.style.fontSize = '12px';
      badge.style.color = '#9e9e9e';
      badge.textContent = 'Playlist‑Kopie';
      // wrap name + badge in a flex column
      const nameWrap = document.createElement('div');
      nameWrap.style.display = 'grid';
      nameWrap.style.gap = '4px';
      name.parentNode && name.parentNode.replaceChild(nameWrap, name);
      nameWrap.appendChild(name);
      nameWrap.appendChild(badge);
    }
    // --- Playlist-Duplizieren/Löschen (wir entfernen die alte +/- Zähler-UI) ---
    const controls = document.createElement('div');
    controls.className = 'seq-reps'; // reuse class for styling
    controls.style.display = 'flex';
    controls.style.alignItems = 'center';
    controls.style.gap = '6px';

    // "+" = duplizieren (erstellt eine Playlist-Kopie direkt unter diesem Eintrag)
    const dupBtn = document.createElement('button');
    dupBtn.className = 'btn';
    dupBtn.textContent = '+';
    dupBtn.title = 'Playlist-Kopie unterhalb einfügen';
    dupBtn.addEventListener('click', ()=>{
      try{
        // Basis für die Kopie: Originalmarker (wenn Kopie, dann dessen Original suchen)
        const baseId = m.playlistCloneOf ? m.playlistCloneOf : m.id;
        const base = markers.find(x => x.id === baseId);
        if(!base) return;
        const clone = {
          id: uid(),
          time: base.time,           // keine Auswirkung auf Waveform (wir blenden Kopien dort aus)
          label: base.label + ' (Kopie)',
          active: false,
          playlistClone: true,
          playlistCloneOf: base.id
        };
        // listOrder: direkt nach die aktuelle Zeile
        ensureListOrder();
        const after = (m.listOrder ?? 0);
        markers.forEach(mm=>{ if((mm.listOrder ?? 0) > after) mm.listOrder = (mm.listOrder ?? 0) + 1; });
        clone.listOrder = after + 1;
        markers.push(clone);
        // Keep array in UI order
        markers.sort((a,b)=> (a.listOrder ?? 0) - (b.listOrder ?? 0));
        renderMarkerList();
      }catch(e){ console.warn('dup error', e); }
    });

    
    // "−" = Kopie entfernen ODER "Mute" bei Original
    const actionBtn = document.createElement('button');
    actionBtn.className = 'btn';
    if(m.playlistClone === true){
      actionBtn.textContent = '−';
      actionBtn.title = 'Diese Playlist-Kopie entfernen';
      actionBtn.addEventListener('click', ()=>{
        try{
          if(arrangementEditorMode && arrangementSegments.length > 0){
            const mySegs = arrangementSegments.filter(s => s.markerId === m.id);
            const hasContent = mySegs.some(s => {
              for(let j = 0; j < s.lineCount; j++){
                if((lyrics[s.lineStartIdx + j] || '').trim().length > 0) return true;
              }
              return false;
            });
            if(hasContent){
              _showCloneDeleteDialog(m);
              return;
            }
          }
          _deleteCloneMarker(m, false);
        }catch(e){ console.warn('del error', e); }
      });
    }else{
      // ORIGINAL: Mute-Schalter
      actionBtn.textContent = (m.muted ? 'Unmute' : 'Mute');
      actionBtn.title = 'Originalspur stummschalten (aus Reihenfolge ausklammern)';
      actionBtn.addEventListener('click', ()=>{
        try{
          m.muted = !m.muted;
          renderMarkerList();
          if(arrangementEditorMode) applyArrangementToEditor();
          try{
            if(window.playSeqOrder && typeof window.getPlayheadTime === 'function' && typeof window.startEngineAt === 'function'){
              startEngineAt(getPlayheadTime());
            }
          }catch(_){}
        }catch(e){ console.warn('mute toggle error', e); }
      });
    }


    
    // --- Notizblock-Schaltfläche nur für Kopiespuren ---
    let noteWrap = null;
    if (m.playlistClone === true) {
      const noteBtn = document.createElement('button');
      noteBtn.className = 'btn btn-sm';
      noteBtn.title = 'Notiz zu dieser Kopie hinzufügen/anzeigen';
      noteBtn.setAttribute('aria-label','Notiz');
      noteBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 5a2 2 0 0 1 2-2h8l6 6v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5z" stroke="#90caf9" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"></path><path d="M14 3v4a2 2 0 0 0 2 2h4" stroke="#90caf9" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"></path></svg>';

      // kleiner Indikator, wenn Text vorhanden ist
      function updateNoteIndicator(){
        try{
          if (m.note && String(m.note).trim().length > 0){
            noteBtn.style.borderColor = '#5c9eff';
            noteBtn.style.boxShadow = '0 0 0 2px rgba(92,158,255,.15) inset';
          } else {
            noteBtn.style.borderColor = '';
            noteBtn.style.boxShadow = '';
          }
        }catch(_){}
      }

      // Editor (ausklappbar) unter der Zeile
      noteWrap = document.createElement('div');
      noteWrap.style.gridColumn = '1 / -1';
      noteWrap.style.marginTop = '8px';
      noteWrap.style.display = (m.note && m.note.length) ? 'block' : 'none';

      const noteArea = document.createElement('textarea');
      noteArea.className = 'field';
      noteArea.rows = 2;
      noteArea.placeholder = 'Notiz für diese Kopiespur …';
      noteArea.value = (m.note || '');
      noteArea.addEventListener('input', ()=>{ m.note = noteArea.value; updateNoteIndicator(); });

      noteWrap.appendChild(noteArea);

      noteBtn.addEventListener('click', ()=>{
        const vis = (noteWrap.style.display !== 'none');
        noteWrap.style.display = vis ? 'none' : 'block';
        if (!vis) { try { noteArea.focus(); } catch(_){ } }
      });

      controls.appendChild(noteBtn);
      updateNoteIndicator();
    }

    controls.appendChild(dupBtn);
    controls.appendChild(actionBtn);

    if (noteWrap) { row.appendChild(noteWrap); }
row.appendChild(handle);
    row.appendChild(name);
    row.appendChild(controls);
    markerListEl.appendChild(row);
  });
  try{ updateMarkerRowHighlight(cursorTime); }catch(_){}
}
// --- Buttons ---
    addMarkerBtn.addEventListener('click', ()=>{
  if(duration<=0) return alert('Bitte zuerst eine Audiodatei laden.');
  const name = prompt('Name für den Marker:'); if(name===null) return;
  const t = cursorTime;
  const newM = { id: uid(), time: clamp(snapToGrid(t),0,duration), label: name, active: false, seqReps: 1 };
  insertMarkerAscending(newM);
  renderMarkerList(); draw();
});

    deleteMarkerBtn.addEventListener('click', ()=>{
      if(duration<=0 || markers.length===0) return;
      // nächster Marker zum Cursor
      let idx=-1, best=Infinity;
      for(let i=0;i<markers.length;i++){
        const d=Math.abs(markers[i].time - cursorTime);
        if(d<best){ best=d; idx=i; }
      }
      if(idx>=0){
        const wasActive=!!markers[idx].active;
        markers.splice(idx,1);
        renderMarkerList(); draw();
        if(usingEngine && wasActive) resumeWithUpdatedLoopPreservingPhase();
      }
    });

    playSel.addEventListener('click', async ()=>{ await ensureACResumed(); startEngineAt(cursorTime); });
    pauseBtn.addEventListener('click', ()=>{ stopEngine(); });
    // Floating play/stop buttons mirror behavior
    document.getElementById('floatPlay')?.addEventListener('click', async ()=>{ await ensureACResumed(); startEngineAt(cursorTime); });
    document.getElementById('floatStop')?.addEventListener('click', ()=>{ stopEngine(); });

    // Stop-Button: Double-Tap → Cursor zum Loop-Anfang springen
    // - Custom Arrangement aktiv? → erster Marker in Listenreihenfolge
    // - 2 aktive Marker (Loop)? → Startmarker des Loops
    // - sonst → 0:00
    (function(){
      const DOUBLE_MS = 320;
      function wireStopDblTap(btn){
        if(!btn) return;
        let last = 0, clearTok = null;
        btn.addEventListener('click', ()=>{
          const now = performance.now();
          if(now - last < DOUBLE_MS){
            clearTimeout(clearTok); last = 0;
            if(playSeqOrder){
              // __jumpToLoopStart sets both the cursor AND seqCurrentStartId correctly.
              // The old inline code only set the cursor, leaving seqCurrentStartId stale.
              try{ if(typeof __jumpToLoopStart === 'function') __jumpToLoopStart(); }catch(_){}
              // Clear any stale tap-highlight: if the user had previously tapped a marker,
              // _seqTapHlId would still be set. The startEngineAt wrapper preferentially uses
              // _seqTapHlId over the cursor position, so without clearing it Play would jump
              // to the old tapped marker instead of the first arrangement position.
              try{
                window._seqTapHlId = null;
                document.querySelectorAll('.seq-tap-hl').forEach(r => r.classList.remove('seq-tap-hl'));
              }catch(_){}
            } else {
              let target = 0;
              const act = getActiveMarkersSorted();
              if(Array.isArray(act) && act.length === 2)
                target = Math.min(act[0].time, act[1].time);
              setCursor(target, true);
              draw();
            }
            return;
          }
          last = now;
          clearTimeout(clearTok);
          clearTok = setTimeout(()=>{ last = 0; }, DOUBLE_MS + 40);
        }, { passive: true });
      }
      wireStopDblTap(pauseBtn);
      wireStopDblTap(document.getElementById('floatStop'));
    })();

    // === Desktop Tastaturkürzel ===
    // Space = Play/Stop (doppelt gestoppt = Sprung zum Loop-Anfang) | Backspace = Sprung zum Loop-Anfang
    // Ctrl+Z = Undo | Ctrl+T = Marker setzen | Ctrl+R = Marker entfernen

    // Pre-Play-Cursor: Position und Loop-Zustand vor Wiedergabestart merken
    let __prePlayCursor = null;
    let __prePlayWasInLoop = false;

    function __recordPrePlay() {
      try {
        __prePlayCursor = cursorTime;
        const loop = getLoopRegion();
        const loopActive = loop.mode === 'markers' || loop.mode === 'quick';
        __prePlayWasInLoop = loopActive &&
          cursorTime >= loop.s - 1e-4 && cursorTime <= loop.e + 1e-4;
      } catch(_) { __prePlayWasInLoop = false; }
    }

    // Nach stopEngine() prüfen ob Cursor zurückspringen soll
    function __applyStopReturn() {
      try {
        if (__prePlayWasInLoop && __prePlayCursor !== null) {
          const loop = getLoopRegion();
          if (loop.mode === 'markers' || loop.mode === 'quick') {
            setCursor(__prePlayCursor, false);
            draw();
          }
        }
      } catch(_) {}
      __prePlayCursor = null;
      __prePlayWasInLoop = false;
    }

    // Float-Buttons einklinken (nach den bereits registrierten Listenern)
    document.getElementById('floatPlay')?.addEventListener('click', __recordPrePlay);
    document.getElementById('floatStop')?.addEventListener('click', __applyStopReturn);

    function __jumpToLoopStart() {
      try {
        // Checkbox-Zustand ist die verlässlichste Quelle für Custom Arrangement
        const seqActive = !!(document.getElementById('playSeqToggle')?.checked);
        if (seqActive) {
          // Custom Arrangement: Sprung zum ersten Marker nach listOrder
          // __markersByList() ist global und sortiert korrekt nach listOrder
          const ls = (typeof __markersByList === 'function') ? __markersByList()
                   : (typeof markers !== 'undefined' ? [...markers].sort((a,b)=>(a.listOrder??0)-(b.listOrder??0)) : []);
          let fm = null;
          for (const m of ls) {
            if (!m || m.pin === 'end') continue;
            if (m.muted === true && m.playlistClone !== true) continue;
            fm = m; break;
          }
          if (fm) {
            try { seqCurrentStartId = fm.id; } catch(_){}
            setCursor(fm.time || 0, true); draw(); return;
          }
          setCursor(0, true); draw();
        } else {
          // Marker-Loop oder Quick-Loop: Sprung zum Loop-Start; sonst Gesamtanfang
          const loop = getLoopRegion();
          if (loop.mode === 'markers' || loop.mode === 'quick') {
            setCursor(loop.s, true);
          } else {
            setCursor(0, true);
          }
          draw();
        }
      } catch(_) { try { setCursor(0, true); draw(); } catch(_){} }
    }

    window.addEventListener('keydown', async function __kbShortcuts(e) {
      // Ignorieren wenn ein Eingabefeld aktiv ist
      const activeEl = document.activeElement;
      if (activeEl) {
        const tag = activeEl.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || activeEl.isContentEditable) return;
      }

      // Space: Play/Stop
      if ((e.key === ' ' || e.code === 'Space') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        if (usingEngine) {
          stopEngine();
          __applyStopReturn();   // ggf. Cursor zur Pre-Play-Position zurücksetzen
        } else {
          __recordPrePlay();           // Pre-Play-Position vor Start merken
          await ensureACResumed();
          startEngineAt(cursorTime);
        }
        return;
      }

      // Backspace: Stopp + Cursor zum Anfang des aktiven Loops
      if (e.key === 'Backspace' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        if (usingEngine) stopEngine();
        __jumpToLoopStart();
        return;
      }

      // Ctrl+Z: Undo
      if (e.key === 'z' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        undoTrim();
        return;
      }

      // T: Marker setzen
      if (e.key === 't' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        addMarkerBtn?.click();
        return;
      }

      // R: Marker entfernen
      if (e.key === 'r' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        deleteMarkerBtn?.click();
        return;
      }

      // A: Nächsten Marker am Cursor aktiv/inaktiv schalten
      if (e.key === 'a' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        if (typeof markers !== 'undefined' && markers.length > 0) {
          let idx = -1, best = Infinity;
          for (let i = 0; i < markers.length; i++) {
            const d = Math.abs((markers[i].time ?? 0) - cursorTime);
            if (d < best) { best = d; idx = i; }
          }
          if (idx >= 0) {
            const m = markers[idx];
            m.active = !m.active;
            if (m.active) {
              ensureMaxTwoActive(m);
              if (!m.pin) markers.forEach(x => { if (x.pin === 'start' || x.pin === 'end') x.active = false; });
            }
            renderMarkerList();
            draw();
            if (usingEngine) resumeWithUpdatedLoopPreservingPhase();
          }
        }
        return;
      }

      // S: Snap Grid ein/ausschalten
      if (e.key === 's' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        snapEnabled = !snapEnabled;
        updateGridSnapUI();
        return;
      }

      // Shift + Pfeiltaste links/rechts: zum nächsten Marker springen
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        if (typeof markers !== 'undefined' && markers.length > 0) {
          const EPS = 1e-4;
          let best = null;
          if (e.key === 'ArrowLeft') {
            for (const m of markers) {
              if ((m.time ?? 0) < cursorTime - EPS) {
                if (best === null || m.time > best.time) best = m;
              }
            }
          } else {
            for (const m of markers) {
              if ((m.time ?? 0) > cursorTime + EPS) {
                if (best === null || m.time < best.time) best = m;
              }
            }
          }
          if (best !== null) { setCursor(best.time, false); draw(); }
        }
        return;
      }

      // Pfeiltaste links/rechts: Rasterpunkt-Sprung (Snap AN) oder freie Bewegung (Snap AUS)
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        if (snapEnabled) {
          // Zum nächsten Rasterpunkt springen
          const step = gridStep();
          const current = Math.round(cursorTime / step);
          const target = (current + dir) * step;
          setCursor(target, false);
        } else {
          // Freie Bewegung: 0.1 Sekunden pro Tastendruck
          setCursor(cursorTime + dir * 0.1, false);
        }
        draw();
        return;
      }
    });

    // === Fokus-Rückgabe: Enter in Eingabefeldern + Checkboxen ===
    // Enter in Inputs/Selects → sofort blur, damit Shortcuts wieder greifen
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const el = document.activeElement;
      if (!el) return;
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        el.blur();
      }
    });
    // Checkboxen → nach change sofort blur
    document.addEventListener('change', (e) => {
      const el = e.target;
      if (el && el.tagName === 'INPUT' && el.type === 'checkbox') {
        el.blur();
      }
    });

// --- Export WAV (Custom Arrangement) ---
const exportWavBtn = document.getElementById('exportWavBtn');
const exportStatus = document.getElementById('exportStatus');

function __markersByList(){
  if(!Array.isArray(markers)) return [];
  return markers.slice().sort((a,b)=> (a.listOrder ?? 0) - (b.listOrder ?? 0));
}
function __markersByTime(){
  if(!Array.isArray(markers)) return [];
  return markers.slice().sort((a,b)=> (a.time ?? 0) - (b.time ?? 0) || (a.id || '').localeCompare(b.id||''));
}
function __getMarkerById(id){
  return (markers||[]).find(m=> m && m.id === id) || null;
}
function __segmentEndTimeForStartId(id){
  const m = __getMarkerById(id); if(!m) return duration || 0;
  const t0 = Math.max(0, Math.min(duration||0, m.time||0));
  const chrono = __markersByTime();
  const idx = chrono.findIndex(x=> x.id === id);
  let end = duration || 0;
  for(let i=idx+1;i<chrono.length;i++){
    const mm = chrono[i];
    if((mm.time||0) > t0 + 1e-6){ end = mm.time||0; break; }
  }
  return Math.max(t0, Math.min(end, duration||0));
}
function __repsFor(id){
  const m = __getMarkerById(id);
  const r = Math.max(1, Math.floor((m && m.seqReps) ? m.seqReps : 1));
  return isFinite(r) ? r : 1;
}
function __isMutedOriginal(m){
  return !!(m && m.muted === true && m.playlistClone !== true);
}

function buildArrangementSegmentsSR(sr){
  try{ if(typeof ensureListOrder === 'function') ensureListOrder(); }catch(_){}
  const list = __markersByList();
  const segs = [];
  for(const m of list){
    if(!m || m.pin === 'end') continue;
    if(__isMutedOriginal(m)) continue;
    const s = Math.max(0, Math.min(duration||0, m.time||0));
    const e = __segmentEndTimeForStartId(m.id);
    const len = e - s;
    if(!(len > 1e-4)) continue;
    const reps = __repsFor(m.id);
    const sSmp = Math.floor(s * sr);
    const eSmp = Math.floor(e * sr);
    for(let i=0;i<reps;i++){
      segs.push({ s: sSmp, e: eSmp });
    }
  }
  return segs;
}

// ===== Custom-Arrangement-Editor-Funktionen =====

// --- Hilfsfunktionen für Kopiespur-Löschung ---
function _deleteCloneMarker(m, keepOrphaned){
  try{
    if(keepOrphaned && arrangementEditorMode && arrangementSegments.length > 0){
      const mySegs = arrangementSegments.filter(s => s.markerId === m.id);
      for(const seg of mySegs){
        const lines = [];
        for(let j = 0; j < seg.lineCount; j++) lines.push(lyrics[seg.lineStartIdx + j] || '');
        // Gruppenbezeichnung: Label + ggf. Wiederholungsindex
        let groupLabel = seg.label || m.label || '–';
        if(seg.totalReps > 1) groupLabel += ' (' + (seg.repIndex + 1) + '/' + seg.totalReps + ')';
        orphanedLines.push({ label: groupLabel, lines });
      }
    }
    const idx = markers.findIndex(x => x.id === m.id);
    if(idx >= 0){
      const removedOrder = markers[idx].listOrder ?? idx;
      markers.splice(idx, 1);
      markers.forEach(mm=>{ if((mm.listOrder ?? 0) > removedOrder) mm.listOrder = (mm.listOrder ?? 0) - 1; });
      renderMarkerList();
      if(arrangementEditorMode) applyArrangementToEditor();
    }
  }catch(e){ console.warn('_deleteCloneMarker error', e); }
}

function _showCloneDeleteDialog(m){
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.style.cssText = 'display:flex;z-index:200000;';
  backdrop.innerHTML = `
    <div class="modal-card" style="max-width:360px" role="dialog" aria-modal="true">
      <div class="modal-header">
        <div class="modal-title">Kopiespur löschen</div>
      </div>
      <div class="modal-body" style="padding:8px 0;font-size:14px;color:#e2e2e2;line-height:1.5;">
        Achtung, Zeilen enthalten Text, auch löschen?
      </div>
      <div class="modal-footer" style="gap:10px;">
        <button class="btn" id="_dcd_ja">Ja</button>
        <button class="btn" id="_dcd_nein">Nein</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  function close(){ backdrop.remove(); }
  backdrop.querySelector('#_dcd_ja').addEventListener('click', ()=>{ close(); _deleteCloneMarker(m, false); });
  backdrop.querySelector('#_dcd_nein').addEventListener('click', ()=>{ close(); _deleteCloneMarker(m, true); });
  backdrop.addEventListener('click', e=>{ if(e.target === backdrop) close(); });
}

function buildArrangementForEditor(){
  try{ if(typeof ensureListOrder === 'function') ensureListOrder(); }catch(_){}
  const bl = barLen();
  if(!isFinite(bl) || bl <= 0) return [];
  const list = __markersByList();
  const segments = [];
  const occurrenceCount = {}; // markerId → bisherige Anzahl Vorkommen (für segKey + repIndex)

  for(const m of list){
    if(!m || m.pin === 'end') continue;
    const audioStart = Math.max(0, Math.min(duration||0, m.time||0));
    const audioEnd   = __segmentEndTimeForStartId(m.id);
    const segDur     = audioEnd - audioStart;
    if(segDur < 1e-4) continue;

    const totalReps = __repsFor(m.id);
    const bars      = Math.floor((segDur + timeTol()) / bl);
    const lineCount = Math.floor(bars / 2);
    if(lineCount <= 0) continue;

    for(let repIdx = 0; repIdx < totalReps; repIdx++){
      const occIdx = (occurrenceCount[m.id] || 0);
      occurrenceCount[m.id] = occIdx + 1;
      segments.push({
        markerId:   m.id,
        label:      (m.label || '').trim(),
        audioStart,
        audioEnd,
        isClone:    !!m.playlistClone,
        isMuted:    __isMutedOriginal(m),
        cloneOf:    m.playlistCloneOf || null,
        repIndex:   repIdx,
        totalReps,
        lineStartIdx: -1, // wird unten gesetzt
        lineCount,
        segKey:     m.id + '_' + occIdx,
      });
    }
  }

  // lineStartIdx zuweisen
  let runningLine = 0;
  for(const seg of segments){
    seg.lineStartIdx = runningLine;
    runningLine += seg.lineCount;
  }
  return segments;
}

function applyArrangementToEditor(){
  const bl = barLen();
  if(!isFinite(bl) || bl <= 0){
    alert('Bitte BPM einstellen, damit das Arrangement berechnet werden kann.');
    return;
  }
  const segs = buildArrangementForEditor();
  if(segs.length === 0){
    alert('Keine verwertbaren Segmente im Custom Arrangement gefunden.');
    return;
  }

  const totalLines = segs[segs.length - 1].lineStartIdx + segs[segs.length - 1].lineCount;
  const newLyrics  = new Array(totalLines).fill('');

  if(arrangementEditorMode && arrangementSegments.length > 0){
    // Bereits im Arrangement-Modus: Inhalte per segKey (= markerId-gebunden) übertragen.
    // Die segKey ist stabile Marker-ID + Wiederholungsindex, unabhängig von der
    // Position im Arrangement. Dadurch folgt der Inhalt immer dem zugehörigen Marker.
    const oldKeyToLines = new Map();
    for(const oldSeg of arrangementSegments){
      oldKeyToLines.set(oldSeg.segKey, lyrics.slice(oldSeg.lineStartIdx, oldSeg.lineStartIdx + oldSeg.lineCount));
    }
    for(const newSeg of segs){
      const oldLines = oldKeyToLines.get(newSeg.segKey) || [];
      for(let j = 0; j < Math.min(newSeg.lineCount, oldLines.length); j++){
        newLyrics[newSeg.lineStartIdx + j] = oldLines[j] || '';
      }
    }
  } else {
    // Erstmaliger Wechsel in den Arrangement-Modus:
    // Inhalte aus dem bisherigen zeitbasierten Layout einmalig übernehmen.
    for(const seg of segs){
      for(let lOff = 0; lOff < seg.lineCount; lOff++){
        const newIdx     = seg.lineStartIdx + lOff;
        const audioTime  = seg.audioStart + lOff * 2 * bl;
        const oldBarIdx  = Math.floor((audioTime + timeTol()) / bl);
        const oldLineIdx = Math.floor(oldBarIdx / 2);
        if(oldLineIdx >= 0 && oldLineIdx < lyrics.length && lyrics[oldLineIdx]){
          newLyrics[newIdx] = lyrics[oldLineIdx];
        }
      }
      // Klone erhalten zunächst leere Zeilen (eigener, unabhängiger Inhalt)
    }
  }

  lyrics             = newLyrics;
  arrangementSegments = segs;
  arrangementEditorMode = true;
  perSegmentLineNumbering = true;
  try{ if(importMarkersBtn) importMarkersBtn.classList.add('active'); }catch(_){}
  renderLyricsList();
}

// ===== Ende Custom-Arrangement-Editor-Funktionen =====

function encodeWavFromBuffer(buf){
  const numCh = buf.numberOfChannels|0;
  const sr = buf.sampleRate|0;
  const len = buf.length|0;

  const outLenBytes = 44 + len * numCh * 2;
  const ab = new ArrayBuffer(outLenBytes);
  const view = new DataView(ab);

  function writeString(off, str){
    for(let i=0;i<str.length;i++) view.setUint8(off+i, str.charCodeAt(i));
  }
  function write16(off, v){ view.setUint16(off, v, true); }
  function write32(off, v){ view.setUint32(off, v, true); }

  // RIFF header
  writeString(0, 'RIFF');
  write32(4, 36 + len * numCh * 2);
  writeString(8, 'WAVE');
  // fmt chunk
  writeString(12, 'fmt ');
  write32(16, 16);           // PCM chunk size
  write16(20, 1);            // PCM format
  write16(22, numCh);
  write32(24, sr);
  write32(28, sr * numCh * 2);
  write16(32, numCh * 2);
  write16(34, 16);
  // data chunk
  writeString(36, 'data');
  write32(40, len * numCh * 2);

  // Interleave + write
  const chData = Array.from({length:numCh}, (_,c)=> buf.getChannelData(c));
  let offset = 44;
  for(let i=0;i<len;i++){
    for(let ch=0; ch<numCh; ch++){
      let s = chData[ch][i] || 0;
      s = Math.max(-1, Math.min(1, s));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      offset += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

async function exportArrangementWav(){
  if(!audioBuffer || !duration){ alert('Bitte zuerst eine Audiodatei laden.'); return; }
  try{
    if(exportStatus){ exportStatus.style.display = 'block'; exportStatus.textContent = 'Bereite Export vor…'; }
    if(exportWavBtn){ exportWavBtn.disabled = true; exportWavBtn.textContent = 'Exportiere…'; }

    // If the async pitch/tempo worker is still running, wait for it to finish
    // before reading getPlaybackBuffer() – otherwise we'd get the unshifted fallback.
    if(typeof _pitchPending !== 'undefined' && _pitchPending){
      if(exportStatus) exportStatus.textContent = 'Warte auf Pitch/Tempo-Verarbeitung…';
      await new Promise(resolve => {
        const poll = () => { if(!_pitchPending) resolve(); else requestAnimationFrame(poll); };
        requestAnimationFrame(poll);
      });
    }

    // Source buffer: honours both pitch shift and tempo shift.
    // pitchedBuffer is designed for playback at playbackRate = tf.
    // Since a WAV file always plays at 1.0×, we must resample afterwards
    // (see "tempo resampling" step below) to bake tf into the file.
    const tf = (typeof getPlaybackRate === 'function') ? getPlaybackRate() : 1;
    const applyTempo = Math.abs(tf - 1) > 1e-4;
    const srcBuf = (typeof getPlaybackBuffer === 'function' ? (getPlaybackBuffer() || audioBuffer) : audioBuffer);
    const sr = srcBuf.sampleRate|0;
    const numCh = srcBuf.numberOfChannels|0;

    // Build segments (positions are in pitchedBuffer sample-space, which maps
    // 1-to-1 with the original because WSOLA preserves temporal position).
    const segs = buildArrangementSegmentsSR(sr);
    if(!segs.length){
      if(exportStatus){ exportStatus.textContent = 'Kein Inhalt im Custom Arrangement.'; }
      if(exportWavBtn){ exportWavBtn.disabled=false; exportWavBtn.textContent='Arrangement als WAV exportieren'; }
      return;
    }

    // Total length in pitchedBuffer samples
    let total = 0;
    for(const seg of segs){ total += Math.max(0, (seg.e|0) - (seg.s|0)); }
    const outBuf = createNewBuffer(numCh, total, sr);
    if(!outBuf){ alert('Konnte Zielpuffer nicht erstellen.'); if(exportStatus){ exportStatus.style.display='none'; } if(exportWavBtn){ exportWavBtn.disabled=false; exportWavBtn.textContent='Arrangement als WAV exportieren'; } return; }

    // Copy segments with progress (chunked to keep UI responsive)
    const CHUNK = 262144;
    const srcCh = Array.from({length:numCh}, (_,c)=> srcBuf.getChannelData(c));
    const dstCh = Array.from({length:numCh}, (_,c)=> outBuf.getChannelData(c));
    let dstPos = 0;
    let done = 0;
    // Weight copy phase as 70 % of progress bar, resample as 30 % (if active)
    const copyWeight = applyTempo ? 0.7 : 1.0;

    for(let idx=0; idx<segs.length; idx++){
      const {s, e} = segs[idx];
      const len = Math.max(0, (e|0) - (s|0));
      let copied = 0;
      while(copied < len){
        const n = Math.min(CHUNK, len - copied);
        for(let ch=0; ch<numCh; ch++){
          dstCh[ch].set(srcCh[ch].subarray(s + copied, s + copied + n), dstPos);
        }
        copied += n;
        dstPos += n;
        done += n;

        if((done & 0xFFFF) === 0){
          const pct = Math.round((done / total) * 100 * copyWeight);
          if(exportStatus){ exportStatus.textContent = `Export … ${pct}%`; }
          await new Promise(requestAnimationFrame);
        }
      }
    }

    // ── Tempo resampling ──────────────────────────────────────────────────────
    // pitchedBuffer is meant to be played at playbackRate = tf.
    // A WAV plays at 1.0×, so:
    //   • without correction: tempo sounds at 1× (not tf), pitch = pitchFactor/tf
    //   • after resampling from `total` → `round(total/tf)` samples:
    //       tempo = tf (shorter/longer file), pitch = pitchFactor ✓
    // We use 4-point cubic Hermite interpolation to preserve audio quality.
    let finalBuf = outBuf;
    if(applyTempo){
      if(exportStatus){ exportStatus.textContent = 'Tempo einrechnen…'; }
      await new Promise(requestAnimationFrame);

      const exportLen = Math.max(1, Math.round(total / tf));
      const resampledBuf = createNewBuffer(numCh, exportLen, sr);
      if(!resampledBuf){ throw new Error('Konnte Resample-Puffer nicht erstellen.'); }

      const ratio = total / exportLen; // > 1 for faster tempo, < 1 for slower
      for(let ch = 0; ch < numCh; ch++){
        const inp = outBuf.getChannelData(ch);
        const out2 = resampledBuf.getChannelData(ch);
        for(let i = 0; i < exportLen; i++){
          const pos = i * ratio;
          const j   = pos | 0;
          const fr  = pos - j;
          const y0  = inp[Math.max(0, j - 1)];
          const y1  = inp[j] || 0;
          const y2  = inp[Math.min(total - 1, j + 1)];
          const y3  = inp[Math.min(total - 1, j + 2)];
          const a   = -0.5*y0 + 1.5*y1 - 1.5*y2 + 0.5*y3;
          const b   =      y0 - 2.5*y1 + 2.0*y2 - 0.5*y3;
          const c   = -0.5*y0           + 0.5*y2;
          out2[i]   = ((a*fr + b)*fr + c)*fr + y1;

          if((i & 0x3FFFF) === 0){
            const pct = Math.round(70 + (i / exportLen) * 30);
            if(exportStatus){ exportStatus.textContent = `Export … ${pct}%`; }
          }
        }
      }
      finalBuf = resampledBuf;
      await new Promise(requestAnimationFrame);
    }
    // ─────────────────────────────────────────────────────────────────────────

    if(exportStatus){ exportStatus.textContent = 'WAV erstellen…'; }
    const blob = encodeWavFromBuffer(finalBuf);
    
    // Android bridge save if available

    const base = (typeof loadedFileMeta !== 'undefined' && loadedFileMeta && loadedFileMeta.name ? loadedFileMeta.name.replace(/\.[^.]+$/, '') : 'track');
    const filename = `${base}-arrangement.wav`;
    if (window.Android && Android.saveWavBase64) {
      try {
        if(exportStatus){ exportStatus.textContent = 'Speichere…'; }
        const buf = await blob.arrayBuffer();
        let binary = '';
        const bytes = new Uint8Array(buf);
        const chunk = 0x8000;
        for(let i=0;i<bytes.length;i+=chunk){ binary += String.fromCharCode.apply(null, bytes.subarray(i, i+chunk)); }
        const b64 = btoa(binary);
        Android.saveWavBase64(b64, filename);
        if(exportStatus){ exportStatus.textContent = 'Fertig ✅'; }
      } catch(e) {
        console.warn('Android saveWavBase64 failed, falling back to download', e);
        const a = document.createElement('a');
        a.download = filename;
        a.href = URL.createObjectURL(blob);
        a.style.display = 'none'; document.body.appendChild(a); a.click();
        setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 4000);
        if(exportStatus){ exportStatus.textContent = 'Fertig ✅'; }
      }
    } else {
        const a = document.createElement('a');
        a.download = filename;
        a.href = URL.createObjectURL(blob);
        a.style.display = 'none'; document.body.appendChild(a); a.click();
        setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 4000);
        if(exportStatus){ exportStatus.textContent = 'Fertig ✅'; }
    }

} catch(err){
    console.warn('Export WAV failed:', err);
    alert('Export fehlgeschlagen: ' + (err && err.message ? err.message : err));
    if(exportStatus){ exportStatus.style.display = 'none'; }
  } finally {
    if(exportWavBtn){ exportWavBtn.disabled = false; exportWavBtn.textContent = 'Arrangement als WAV exportieren'; }
  }
}

if(exportWavBtn){ exportWavBtn.addEventListener('click', exportArrangementWav); }



    clearBtn.addEventListener('click', ()=>{
      stopEngine();
      if(objectUrl) URL.revokeObjectURL(objectUrl); objectUrl=null;
      fileInput.value=''; fileInfo.textContent='–'; duration=0; audioBuffer=null; viewStart=0; viewDur=0;
      markers=[]; cursorTime=0; renderMarkerList(); draw();
      // Editor zurücksetzen
      lyrics = []; markerHeaders=[]; lastActiveLine = -1;
      arrangementEditorMode = false; arrangementSegments = [];
      _arrangementRestoreData = null; orphanedLines = [];
      try{ if(importMarkersBtn) importMarkersBtn.classList.remove('active'); }catch(_){}
      renderLyricsList();
    });
// --- Custom Arrangement übernehmen ---
    if(importMarkersBtn){
      importMarkersBtn.addEventListener('click', ()=>{
        applyArrangementToEditor();
      });
    }
// --- Autoscroll ---

    if(toggleAutoscrollBtn){
      toggleAutoscrollBtn.addEventListener('click', ()=>{
        autoScrollEnabled = !autoScrollEnabled;
        toggleAutoscrollBtn.classList.toggle('active', autoScrollEnabled);
        toggleAutoscrollBtn.textContent = `Autoscroll: ${autoScrollEnabled ? 'An' : 'Aus'}`;
      });
    }
    

    // BPM-Änderungen -> Editor & Raster reagieren
    // BPM-Eingabe: nur Ziffern, Punkt oder Komma als Dezimaltrennzeichen,
    // max. 3 Ganzzahlstellen (0–999), max. 2 Nachkommastellen.
    bpmInput.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey) return;
      const nav = ['Backspace','Delete','Tab','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','Enter'];
      if (nav.includes(e.key)) return;
      if (/^\d$/.test(e.key)) return;
      if ((e.key === '.' || e.key === ',') && !/[.,]/.test(bpmInput.value)) return;
      e.preventDefault();
    });
    bpmInput.addEventListener('input', () => {
      let v = bpmInput.value;
      // Ungültige Zeichen entfernen, Komma zu Punkt normalisieren
      v = v.replace(/[^\d.,]/g, '').replace(',', '.');
      // Nur einen Dezimalpunkt erlauben
      const parts = v.split('.');
      if (parts.length > 2) v = parts[0] + '.' + parts.slice(1).join('');
      // Ganzzahlanteil auf 3 Stellen begrenzen
      const sepIdx = v.indexOf('.');
      if (sepIdx === -1) {
        v = v.slice(0, 3);
      } else {
        v = v.slice(0, sepIdx).slice(0, 3) + '.' + v.slice(sepIdx + 1).slice(0, 2);
      }
      if (bpmInput.value !== v) bpmInput.value = v;
    });

    bpmInput.addEventListener('change', ()=>{
      // minView ggf. neu anpassen (Snap/Zoom fühlt sich so konsistent an)
      minView=Math.max(0.25, gridStep()/4);
      rebuildLyrics({ preserve:true });
// auto-marker
ensureDefaultStartEndMarkers();
      draw();
      if(usingEngine) resumeWithUpdatedLoopPreservingPhase();
    });

    
    // --- Export TXT ---
// --- Export (Popup) ---
function buildExportPopupText(){
  const { lines } = computeCounts();
  const bl = barLen();
  const headers = [];
  if (isFinite(bl) && bl > 0) {
    (markers||[])
      .filter(m => (m.label || '').trim().length > 0 && m.playlistClone !== true)
      .forEach(m => {
        const barNumber = Math.floor((m.time + timeTol()) / bl) + 1; // 1-basiert
        const lineIdx   = Math.floor((barNumber - 1) / 2) + 1; // 2 Takte pro Zeile
        headers.push({ lineIdx, label: m.label.trim(), bar: barNumber });
      });
    headers.sort((a,b)=> a.lineIdx - b.lineIdx || a.bar - b.bar);
  }
  const headersByLine = new Map();
  headers.forEach(h=>{
    if(h.lineIdx>=1 && h.lineIdx<=lines){
      if(!headersByLine.has(h.lineIdx)) headersByLine.set(h.lineIdx, []);
      headersByLine.get(h.lineIdx).push(h.label);
    }
  });

  const out = [];
  for (let i=0;i<lines;i++){
    const hs = headersByLine.get(i+1) || [];
    // two empty lines before and after each segment header
    hs.forEach(lbl => {
      out.push("");
      out.push(lbl);
      out.push("");
    });
    out.push(lyrics[i] || "");
  }
  return out.join("\n");
}

    function downloadText(filename, text){
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url  = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(()=>URL.revokeObjectURL(url), 1500);
    }

    
exportTxtBtn?.addEventListener('click', ()=>{
  try{
    const modal = document.getElementById('exportModal');
    const ta = document.getElementById('exportTextArea');
    if(!modal || !ta){ alert('Popup konnte nicht geöffnet werden.'); return; }
    ta.value = buildExportPopupText();
    modal.style.display = 'flex';
    ta.focus(); ta.select();
  }catch(e){
    console.warn(e);
  }
});



// Modal controls (delegated & timing-safe)
document.addEventListener('click', async (e) => {
  const modal = document.getElementById('exportModal');
  const ta = document.getElementById('exportTextArea');

  // Close if click on backdrop
  if (modal && e.target === modal) {
    modal.style.display = 'none';
  }

  // Close button
  if (e.target && e.target.id === 'closeExportModal') {
    if (modal) modal.style.display = 'none';
  }

  // Copy button
  if (e.target && e.target.id === 'copyExportText') {
    if (!ta) return;
    try {
      // ensure selection is applied
      ta.focus();
      ta.select();
      // navigator.clipboard first
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(ta.value);
      } else {
        // fallback: execCommand
        const ok = document.execCommand('copy');
        if (!ok) throw new Error('execCommand failed');
      }
      e.target.textContent = 'Kopiert!';
      setTimeout(()=>{ e.target.textContent = 'Alles kopieren'; }, 1200);
    } catch (err) {
      console.warn('Copy failed', err);
      // last-resort fallback: temporary textarea
      try {
        const temp = document.createElement('textarea');
        temp.value = ta.value;
        temp.style.position = 'fixed';
        temp.style.opacity = '0';
        document.body.appendChild(temp);
        temp.focus();
        temp.select();
        document.execCommand('copy');
        document.body.removeChild(temp);
        e.target.textContent = 'Kopiert!';
        setTimeout(()=>{ e.target.textContent = 'Alles kopieren'; }, 1200);
      } catch (_) {
        alert('Kopieren konnte nicht durchgeführt werden.');
      }
    }
  }
});

// --- Init ---
    window.addEventListener('resize', ()=>{ draw(); });
    ensureListOrder(); renderMarkerList(); draw();
    renderLyricsList();
  

// ===== Reihenfolge-Playback Patch =====
(function(){
  // Helper
  function markersByTime(){
    try { return (markers||[]).slice().sort((a,b)=> (a.time||0) - (b.time||0)); } catch(_){ return []; }
  }
  function ensureListOrder(){ try { if(window.ensureListOrder) return window.ensureListOrder(); } catch(_){} }
  function markersByList(){
    try {
      if (typeof window.ensureListOrder === 'function') window.ensureListOrder();
      return (markers||[]).slice().sort((a,b)=> ( (a.listOrder??0) - (b.listOrder??0) ));
    } catch(_){ return []; }
  }
  function getMarkerById(id){
    try { return (markers||[]).find(m => m.id === id) || null; } catch(_){ return null; }
  }
    function findChronoSegmentStartIdAt(t){
    const ts = markersByTime();
    if (ts.length === 0) return null;
    let idx = ts.findIndex(m => (m.time||0) > (t||0)) - 1;
    if (idx < 0) idx = 0;
    const startTime = (ts[idx].time||0);
    const eps = typeof EPS !== 'undefined' ? EPS : 1e-6;
    const sameTime = ts.filter(m => Math.abs((m.time||0) - startTime) <= eps);
    if (sameTime.length === 1) return sameTime[0].id;
    // Multiple markers at the same time: use list order as tie-breaker.
    // This correctly handles playlist clones placed before their originals in Custom Arrangement.
    const byList = sameTime.slice().sort((a,b) => (a.listOrder ?? 0) - (b.listOrder ?? 0));
    const preferred = byList.find(m => m.pin !== 'end');
    return preferred ? preferred.id : ts[idx].id;
  }
    function segmentEndTimeForStartId(id){
    const ts = markersByTime();
    const i = ts.findIndex(m => m.id === id);
    if (i < 0) return duration || 0;
    const startTime = (ts[i].time||0);
    // Find the first subsequent marker with a STRICTLY greater time,
    // skipping any other markers that share the same timestamp.
    let j = i + 1;
    const eps = (typeof EPS!=='undefined'?EPS:1e-6);
    while (j < ts.length && ((ts[j].time||0) <= startTime + eps)) j++;
    return (j < ts.length) ? (ts[j].time||0) : (duration || 0);
  }
  function nextIdInSequence(id){
    const ls = markersByList();
    const i = ls.findIndex(m => m.id === id);
    if(i < 0) return null;
    const nxt = ls[i+1];
    return nxt ? nxt.id : null;
  }

  function smoothJumpTo(t, whenAbs){
  try {
    // Falls Engine nicht läuft: Cursor setzen & ggf. starten
    if(!(typeof usingEngine !== 'undefined' && usingEngine)){
      if(typeof setCursor === 'function') setCursor(t, true);
      if(typeof startEngineAt === 'function') startEngineAt(t);
      else if(typeof draw === 'function') try{ draw(); }catch(_){}
      return;
    }
    if(!(ac && engineSource && masterGain)){
      if(typeof setCursor === 'function') setCursor(t, true);
      if(typeof startEngineAt === 'function') startEngineAt(t);
      return;
    }

    const now  = ac.currentTime;
    const MIN_LEAD   = 0.012;   // minimale Vorlaufzeit zum sicheren Planen (~12ms)
    const FADE_MS    = 0.008;   // sehr kurze De‑Click Crossfade (~8ms)

    // Wenn eine absolute Kontextzeit übergeben wurde (exakter Segment‑Boundary),
    // dann exakt dort springen; sonst mit MIN_LEAD in der Zukunft.
    let when = (Number.isFinite(whenAbs) && whenAbs > (now + 0.002)) ? whenAbs : (now + MIN_LEAD);
    // Safety: nicht zu weit in die Zukunft verschieben
    if (when < now + 0.002) when = now + 0.002;

    // Altes Signal kurz vor 'when' ausblenden und Stop genau an 'when'
    try{
      if (engineGain && engineGain.gain){
        const fadeStart = Math.max(now, when - FADE_MS);
        engineGain.gain.cancelScheduledValues(now);
        // aktuellen Wert halten bis zum FadeStart
        engineGain.gain.setValueAtTime(engineGain.gain.value, now);
        engineGain.gain.setValueAtTime(1, fadeStart);
        engineGain.gain.linearRampToValueAtTime(0, when);
      }
      if (engineSource && typeof engineSource.stop === 'function'){
        try { engineSource.stop(when + 0.004); } catch(_){}
      }
    }catch(_){}

    // Neuen Source/Gain aufbauen, Start & Fade‑In planen
    const src = ac.createBufferSource();
    src.buffer = getPlaybackBuffer() || audioBuffer;
    try{ src.playbackRate.value = getPlaybackRate(); }catch(_){}
    src.loop = false;
    src.loopStart = 0;
    src.loopEnd   = duration || 0;

    const g = ac.createGain();
    // Start bei 0 und sanftes Einblenden ab 'when'
    g.gain.setValueAtTime(0, now);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(1, when + FADE_MS);

    src.connect(g); g.connect(masterGain);

    // State aktualisieren vor Start
    engineSource = src;
    engineGain   = g;

    const startAt = clamp(t, 0, duration || 0);
    engineStartCtxTime = when;
    engineStartOffset  = startAt;

    src.start(when, startAt);
    usingEngine = true;

    try{ if (typeof __setSeqGuard === 'function') __setSeqGuard(320); }catch(_){}

  } catch(_){}
}

  // UI initial state
  try {
    if (typeof playSeqToggle !== 'undefined' && playSeqToggle) {
      playSeqToggle.checked = !!playSeqOrder;
      playSeqToggle.addEventListener('change', ()=>{
        playSeqOrder = !!playSeqToggle.checked;
        if (playSeqOrder && !(window.quickLoop && window.quickLoop.active)) {
          try{ if(typeof clearQuickLoop === 'function') clearQuickLoop(); }catch(_){}
          try{ (markers||[]).forEach(m=> m.active = false); }catch(_){}
          try{ if(typeof renderMarkerList === 'function') renderMarkerList(); }catch(_){}
        }
        try{
          if (typeof usingEngine !== 'undefined' && usingEngine && typeof getPlayheadTime === 'function' && typeof startEngineAt === 'function'){
            startEngineAt(getPlayheadTime());
          try{ if(playSeqOrder && engineSource){ engineSource.loop=false; engineSource.loopStart=0; engineSource.loopEnd=(duration||0); } }catch(_){}
          }
        }catch(_){}
        try{ if(seqInfo) seqInfo.style.opacity = playSeqOrder ? '1' : '.65'; }catch(_){}
        try{ seqCurrentStartId = null; }catch(_){}
      
  try{ __seqRepsLeft = 0; }catch(_){}
});
    }
  } catch(_){}

  // Override getLoopRegion to ignore loops when sequence flag is ON
  try {
    const __orig_getLoopRegion = window.getLoopRegion;
    if (typeof __orig_getLoopRegion === 'function') {
      window.getLoopRegion = function(){
        try{
          if (playSeqOrder && !(window.quickLoop && window.quickLoop.active)) return { s:0, e: duration, mode:'full' };
        }catch(_){}
        return __orig_getLoopRegion();
      };
    }
  } catch(_){}

  // Post-process renderMarkerList to disable marker loop toggles
  try {
    const __orig_renderMarkerList = window.renderMarkerList;
    if (typeof __orig_renderMarkerList === 'function') {
      window.renderMarkerList = function(){
        __orig_renderMarkerList();
        try{
          const rows = document.querySelectorAll('#markerList .markerRow');
          rows.forEach(row => {
            const btn = row.querySelector('button.loop-toggle');
            if(btn){
              btn.disabled = !!playSeqOrder;
              btn.title = playSeqOrder ? 'Ignoriert – Reihenfolge-Playback aktiv' : '';
            }
          });
        }catch(_){}
      };
    }
  } catch(_){}

  // RAF monitor for sequence jumps; wrap startEngineAt/stopEngine
  (function(){
    let __seqRaf = 0;
    function __seqMonitor(){
      try{
        if(!(typeof usingEngine !== 'undefined' && usingEngine && playSeqOrder && !(window.quickLoop && window.quickLoop.active) && !(window.quickLoop && window.quickLoop.active) && (duration||0) > 0 && (markers||[]).length > 0)){
          __seqRaf = 0;
          return;
        }
        const t = (typeof getPlayheadTime === 'function') ? getPlayheadTime() : 0;
        if (!seqCurrentStartId) seqCurrentStartId = findChronoSegmentStartIdAt(t);
        const segEnd = segmentEndTimeForStartId(seqCurrentStartId);
        // Aktuellen Arrangement-Zustand für updateLyricsHighlight bereitstellen
        try { window.__seqMonitorState = { id: seqCurrentStartId, repsLeft: (typeof __seqRepsLeft !== 'undefined' ? __seqRepsLeft : null) }; } catch(_) {}
        

        
// Exakte Kontextzeit, wann wir den Segment‑Boundary erreichen werden
const __rate = (typeof getPlaybackRate === 'function') ? Math.max(1e-6, getPlaybackRate()) : 1;
const __whenAbs = (typeof engineStartCtxTime==='number' && typeof engineStartOffset==='number')
  ? (engineStartCtxTime + Math.max(0, segEnd - engineStartOffset) / __rate) : NaN;
// --- FIX: sofort zum nächsten Marker springen, falls der aktuelle (z.B. der erste bei 0:00) gemutet ist ---
try{
  const __curM = getMarkerById(seqCurrentStartId);
  if (__curM && __curM.muted === true && __curM.playlistClone !== true){
    // finde das nächste abspielbare Segment (nicht gemutet, sinnvolle Länge)
    let __guard = 0;
    let __nid = seqCurrentStartId;
    while(__guard++ < 100){
      __nid = nextIdInSequence(__nid);
      if(!__nid) break;
      const __m2 = getMarkerById(__nid);
      const __end2 = segmentEndTimeForStartId(__nid);
      const __len2 = __m2 ? Math.max(0, __end2 - (__m2.time||0)) : 0;
      const __mutedOriginal = __m2 && __m2.muted === true && __m2.playlistClone !== true;
      if (__len2 > 1e-3 && !__mutedOriginal) break;
    }
    if(__nid){
      seqCurrentStartId = __nid;
      // Optional: Wiederholungszähler zurücksetzen, falls genutzt
      try{ __seqRepsLeft = 1; }catch(_){}
      const __mN0 = getMarkerById(__nid);
      if (__mN0) smoothJumpTo(__mN0.time||0, __whenAbs);
      __seqRaf = requestAnimationFrame(__seqMonitor);
      return;
    }
  }
}catch(_){}
if (t >= segEnd - 0.02){
  // Initialisiere Wiederholungszähler, falls nötig
  if (typeof __seqRepsLeft === 'undefined') { __seqRepsLeft = 0; }
  const curM = getMarkerById(seqCurrentStartId);
  const segStart = curM ? (curM.time||0) : 0;
  const segLen = Math.max(0, (segEnd - segStart));

  
  // Sofort überspringen, wenn aktueller Marker gemutet ist (nur bei Originalen)
  try{
    if (curM && curM.muted === true && curM.playlistClone !== true){
      const nid0 = nextPlayableId(seqCurrentStartId);
      if(nid0){
        seqCurrentStartId = nid0;
        __seqRepsLeft = repsFor(nid0);
        const mN0 = getMarkerById(nid0);
        if (mN0) smoothJumpTo(mN.time||0, __whenAbs);
        __seqRaf = requestAnimationFrame(__seqMonitor);
        return;
      }
    }
  }catch(_){}
function repsFor(id){
    const mm = getMarkerById(id);
    if (!mm) return 1;
    // Wenn Original gemutet: 0 Wiederholungen => wird übersprungen
    if (mm.muted === true && mm.playlistClone !== true) return 0;
    const v = Number.isFinite(mm.seqReps) ? Math.floor(mm.seqReps) : 1;
    return Math.max(0, v);
  }
  function nextPlayableId(id){
    // finde das nächste mit reps>0, sinnvoller Segmentlänge und NICHT gemutet (bei Originalen)
    let guard=0;
    let nid = id;
    while(guard++ < 100){
      nid = nextIdInSequence(nid);
      if(!nid) return null;
      const r = repsFor(nid);
      const m2 = getMarkerById(nid);
      const end2 = segmentEndTimeForStartId(nid);
      const len2 = m2 ? Math.max(0, end2 - (m2.time||0)) : 0;
      const mutedOriginal = m2 && m2.muted === true && m2.playlistClone !== true;
      if (r > 0 && len2 > 1e-3 && !mutedOriginal) return nid;
    }
    return null;
  }


// Helper: first playable start-id for wrapping the Custom Arrangement playlist
function firstPlayableId(){
  try{
    const ls = (typeof markersByList === 'function') ? markersByList() : ((typeof markers !== 'undefined' && markers) || []);
    for(let i=0;i<ls.length;i++){
      const m = ls[i];
      if(!m) continue;
      if(m.pin === 'end') continue; // skip artificial end pin
      const end = segmentEndTimeForStartId(m.id);
      const len = Math.max(0, end - (m.time||0));
      const mutedOriginal = (m.muted === true && m.playlistClone !== true);
      const r = (typeof repsFor === 'function') ? repsFor(m.id) : 1;
      if(r > 0 && len > 1e-3 && !mutedOriginal) return m.id;
    }
  }catch(_){}
  return null;
}



  // Erstmals setzen, wenn 0
  if (!__seqRepsLeft || __seqRepsLeft < 0) {
    __seqRepsLeft = repsFor(seqCurrentStartId);
  }

  // 0-Länge sofort weiterspringen
  if (segLen <= 1e-3) {
    const nid = nextPlayableId(seqCurrentStartId);
    if (nid){
      const mN = getMarkerById(nid);
      seqCurrentStartId = nid;
      __seqRepsLeft = repsFor(nid);
      if (mN) smoothJumpTo(mN.time||0, __whenAbs);
    } else {
      const __fid = (typeof firstPlayableId === 'function') ? firstPlayableId() : null;
      if (__fid){
        const __mF = getMarkerById(__fid);
        seqCurrentStartId = __fid;
        try{ __seqRepsLeft = (typeof repsFor === 'function') ? repsFor(__fid) : 1; }catch(_){}
        if (__mF) smoothJumpTo(__mF.time||0, __whenAbs);
      } else {
        try{ if(typeof stopEngine === 'function') __orig_stopEngine(); }catch(_){}
        __seqRaf = 0; return;
      }
    }
  } else {
    if (__seqRepsLeft > 1){
      __seqRepsLeft -= 1;
      smoothJumpTo(segStart, __whenAbs); // wieder an Segmentanfang springen
    } else {
      const nid = nextPlayableId(seqCurrentStartId);
      if (nid){
        const mN = getMarkerById(nid);
        seqCurrentStartId = nid;
        __seqRepsLeft = repsFor(nid);
        if (mN) smoothJumpTo(mN.time||0, __whenAbs);
      } else {
        const __fid = (typeof firstPlayableId === 'function') ? firstPlayableId() : null;
      if (__fid){
        const __mF = getMarkerById(__fid);
        seqCurrentStartId = __fid;
        try{ __seqRepsLeft = (typeof repsFor === 'function') ? repsFor(__fid) : 1; }catch(_){}
        if (__mF) smoothJumpTo(__mF.time||0, __whenAbs);
      } else {
        try{ if(typeof stopEngine === 'function') __orig_stopEngine(); }catch(_){}
        __seqRaf = 0; return;
      }
    }
    }
  }
}

        __seqRaf = requestAnimationFrame(__seqMonitor);

        // Enforce no-loop when sequence mode is active
        try{
          if (playSeqOrder && !(window.quickLoop && window.quickLoop.active) && typeof engineSource !== 'undefined' && engineSource){
            engineSource.loop = false;
            try{ engineSource.loopStart = 0; }catch(_){}
            try{ engineSource.loopEnd   = (typeof duration !== 'undefined' ? (duration||0) : 0); }catch(_){}
          }
        }catch(_){}

      }catch(_){ __seqRaf = requestAnimationFrame(__seqMonitor);

        // Enforce no-loop when sequence mode is active
        try{
          if (playSeqOrder && !(window.quickLoop && window.quickLoop.active) && typeof engineSource !== 'undefined' && engineSource){
            engineSource.loop = false;
            try{ engineSource.loopStart = 0; }catch(_){}
            try{ engineSource.loopEnd   = (typeof duration !== 'undefined' ? (duration||0) : 0); }catch(_){}
          }
        }catch(_){}
 }
    }

    const __orig_startEngineAt = window.startEngineAt;
    const __orig_stopEngine = window.stopEngine;

    if (typeof __orig_startEngineAt === 'function'){
      window.startEngineAt = function(t){
        __orig_startEngineAt(t);
        try{
          if (playSeqOrder && !(window.quickLoop && window.quickLoop.active)) {
            if(__seqRaf) cancelAnimationFrame(__seqRaf);
            seqCurrentStartId = (window._seqTapHlId && (markers||[]).some(function(m){ return m.id === window._seqTapHlId; }))
              ? window._seqTapHlId
              : findChronoSegmentStartIdAt(t||0);
            __seqRaf = requestAnimationFrame(__seqMonitor);

        // Enforce no-loop when sequence mode is active
        try{
          if (playSeqOrder && !(window.quickLoop && window.quickLoop.active) && typeof engineSource !== 'undefined' && engineSource){
            engineSource.loop = false;
            try{ engineSource.loopStart = 0; }catch(_){}
            try{ engineSource.loopEnd   = (typeof duration !== 'undefined' ? (duration||0) : 0); }catch(_){}
          }
        }catch(_){}

          }
        }catch(_){}
      };
    }

    if (typeof __orig_stopEngine === 'function'){
      window.stopEngine = function(){
        try{ if(__seqRaf){ cancelAnimationFrame(__seqRaf); __seqRaf=0; } }catch(_){}
        __orig_stopEngine();
      };
    }
  })();
})();

  // Make sure loop stays off if external code tries to 'resume' engine while sequence mode is on
  try {
    const __orig_resume = window.resumeWithUpdatedLoopPreservingPhase;
    if (typeof __orig_resume === 'function'){
      window.resumeWithUpdatedLoopPreservingPhase = function(){
        __orig_resume();
        try{
          if (playSeqOrder && !(window.quickLoop && window.quickLoop.active) && typeof engineSource !== 'undefined' && engineSource){
            engineSource.loop = false;
            try{ engineSource.loopStart = 0; }catch(_){}
            try{ engineSource.loopEnd   = (typeof duration !== 'undefined' ? (duration||0) : 0); }catch(_){}
          }
        }catch(_){}
      };
    }
  } catch(_){}
// ===== Ende Reihenfolge-Playback Patch =====

// ===== Tap auf DragHandle: Sprung zu Marker im Custom Arrangement =====
(function(){
  const TAP_MAX_PX = 10;
  const TAP_MAX_MS = 350;
  let _tapData = null;

  // CSS für rotes Highlighting
  (function(){
    const s = document.createElement('style');
    s.textContent =
      '.markerRow.seq-tap-hl{' +
        'border-color:#ef5350!important;' +
        'box-shadow:0 0 0 3px rgba(239,83,80,.22) inset!important;' +
        'background:linear-gradient(180deg,#2a1717,#1f1414)!important;' +
      '}' +
      '.markerRow.seq-tap-hl .dragHandle svg path{stroke:#ef9a9a!important;}';
    document.head.appendChild(s);
  })();

  // Tap-Start aufzeichnen (eigener Listener, läuft parallel zum Drag-Listener)
  markerListEl.addEventListener('pointerdown', function(e) {
    var handle = e.target.closest('.dragHandle');
    if (!handle) { _tapData = null; return; }
    var row = handle.closest('.markerRow');
    if (!row)    { _tapData = null; return; }
    _tapData = { x: e.clientX, y: e.clientY, t: Date.now(), id: row.dataset.id, moved: false };
  });

  // Bewegung tracken (prüft ob aus Tap ein Drag wurde)
  document.addEventListener('pointermove', function(e) {
    if (!_tapData) return;
    var dx = e.clientX - _tapData.x, dy = e.clientY - _tapData.y;
    if (Math.sqrt(dx*dx + dy*dy) > TAP_MAX_PX) _tapData.moved = true;
  }, { passive: true });

  // Tap erkennen bei pointerup
  markerListEl.addEventListener('pointerup', function(e) {
    if (!_tapData) return;
    var td = _tapData; _tapData = null;
    // Kein Tap wenn Finger/Maus sich zu weit bewegt hat oder zu langsam war
    if (td.moved || (Date.now() - td.t) > TAP_MAX_MS) return;
    // Nur im Custom Arrangement (nicht im Quick-Loop)
    if (!playSeqOrder || (window.quickLoop && window.quickLoop.active)) return;
    var marker = (markers || []).find(function(m) { return m.id === td.id; });
    if (!marker) return;

    var isPlaying = (typeof usingEngine !== 'undefined' && usingEngine);

    // Bereits rot markierte Spur erneut antippen → Highlight aufheben,
    // Cursor zum ersten Marker der Arrangement-Reihenfolge zurücksetzen
    if (window._seqTapHlId === td.id) {
      markerListEl.querySelectorAll('.seq-tap-hl').forEach(function(r) {
        r.classList.remove('seq-tap-hl');
      });
      window._seqTapHlId = null;

      var firstRow    = markerListEl.querySelector('.markerRow');
      var firstId     = firstRow ? firstRow.dataset.id : null;
      var firstMarker = firstId ? (markers || []).find(function(m) { return m.id === firstId; }) : null;

      if (firstMarker) {
        if (isPlaying) {
          try {
            var saFn0 = (typeof window.startEngineAt === 'function') ? window.startEngineAt : startEngineAt;
            saFn0(firstMarker.time || 0);
          } catch(_) {}
          // seqCurrentStartId auf ersten Arrangement-Marker korrigieren
          (function(id) {
            setTimeout(function() { try { seqCurrentStartId = id; } catch(_) {} }, 0);
          })(firstId);
        } else {
          try { seqCurrentStartId = firstId; } catch(_) {}
          try { if (typeof setCursor === 'function') setCursor(firstMarker.time || 0, true); } catch(_) {}
        }
      }
      try { if (typeof draw === 'function') draw(); } catch(_) {}
      return;
    }

    // Alte Highlights entfernen, neues rotes Highlight setzen
    markerListEl.querySelectorAll('.seq-tap-hl').forEach(function(r) {
      r.classList.remove('seq-tap-hl');
    });
    var tapRow = Array.from(markerListEl.querySelectorAll('.markerRow'))
                      .find(function(r) { return r.dataset.id === td.id; });
    if (tapRow) tapRow.classList.add('seq-tap-hl');

    // _seqTapHlId VOR dem Engine-Aufruf setzen, damit der startEngineAt-Wrapper
    // es lesen kann und seqCurrentStartId per setTimeout(0) korrekt setzt.
    window._seqTapHlId = td.id;

    if (isPlaying) {
      // Live-Jump: engine neu starten ab getipptem Marker.
      // Läuft durch alle Wrapper (inkl. seqMonitor-Wrapper und tap-IIFE-Wrapper),
      // seqCurrentStartId wird per setTimeout(0) auf td.id korrigiert.
      try {
        var saFn = (typeof window.startEngineAt === 'function') ? window.startEngineAt : startEngineAt;
        saFn(marker.time || 0);
      } catch(_) {}
    } else {
      // Kein Playback aktiv: nur Cursor setzen, kein automatisches Starten
      try { seqCurrentStartId = td.id; } catch(_) {}
      try { if (typeof setCursor === 'function') setCursor(marker.time || 0, true); } catch(_) {}
      // seqCurrentStartId per setTimeout(0) sichern
      (function(id) {
        setTimeout(function() {
          if (window._seqTapHlId === id) {
            try { seqCurrentStartId = id; } catch(_) {}
          }
        }, 0);
      })(td.id);
    }

    try { if (typeof draw === 'function') draw(); } catch(_) {}
  });

  // Wenn ein Tap-Highlight aktiv ist und der User Play drückt, überschreibt der
  // seqMonitor-Wrapper seqCurrentStartId synchron mit dem chronologisch ersten Marker
  // an der Cursor-Position (z.B. eine Kopiespur die an 1. Stelle steht).
  // Fix: window.startEngineAt wrappen und seqCurrentStartId per setTimeout(0)
  // auf den getippten Marker zurückkorrigieren – setTimeout(0) feuert garantiert
  // vor dem ersten RAF-Frame des seqMonitors, der seqCurrentStartId erstmals liest.
  (function(){
    var __prev = window.startEngineAt;
    if (typeof __prev !== 'function') return;
    window.startEngineAt = function(t) {
      var hlId = window._seqTapHlId; // getippter Marker vor dem Aufruf merken
      var r = __prev(t);             // alle bisherigen Wrapper laufen (setzen seqCurrentStartId auf chrono-Marker)
      if (hlId) {
        setTimeout(function() {
          // Nur korrigieren wenn Highlight noch aktiv und Wert falsch ist
          if (window._seqTapHlId === hlId && typeof seqCurrentStartId !== 'undefined' && seqCurrentStartId !== hlId) {
            try { seqCurrentStartId = hlId; } catch(_) {}
          }
        }, 0);
      }
      return r;
    };
  })();

  // Highlight entfernen, sobald das Playback läuft UND seqCurrentStartId
  // auf den nächsten Marker weiterspringt (= Segment-Grenze erreicht).
  // Läuft das Playback nicht, bleibt das Highlight als Cursor-Markierung erhalten.
  (function watchHL() {
    try {
      if (window._seqTapHlId) {
        var playing  = (typeof usingEngine !== 'undefined' && usingEngine);
        var advanced = typeof seqCurrentStartId !== 'undefined' &&
                       seqCurrentStartId !== null &&
                       seqCurrentStartId !== window._seqTapHlId;
        if (playing && advanced) {
          markerListEl.querySelectorAll('.seq-tap-hl').forEach(function(r) {
            r.classList.remove('seq-tap-hl');
          });
          window._seqTapHlId = null;
        }
      }
    } catch(_) {}
    requestAnimationFrame(watchHL);
  })();
})();
// ===== Ende Tap-Sprung Patch =====

/* ========== enforceLoopFromRegion ========== */
(function(){
  function enforceLoopFromRegion(){
    try{
      if (typeof engineSource === 'undefined' || !engineSource) return;
      const reg = (typeof getLoopRegion === 'function') ? getLoopRegion() : {s:0,e:(typeof duration!=='undefined'?duration:0),mode:'full'};
      const loopEnd = reg.e > 0 ? reg.e : (typeof duration!=='undefined'?duration:0);
      const isLoopMode = (reg.mode === 'markers' || reg.mode === 'quick');
      // Looping nur aktivieren wenn der Startpunkt VOR dem Loop-Ende liegt –
      // spiegelgleich zur Logik in startEngineAt (startAt < loopEnd).
      const startOff = (typeof engineStartOffset !== 'undefined') ? engineStartOffset : 0;
      const looping = isLoopMode && (startOff < loopEnd);
      try { engineSource.loop = looping; } catch(_){}
      try { engineSource.loopStart = looping ? reg.s : 0; } catch(_){}
      try { engineSource.loopEnd   = looping ? loopEnd : (typeof duration!=='undefined'?duration:0); } catch(_){}
    }catch(_){}
  }

  // Wrap startEngineAt to enforce loop state when Playlist AUS
  try{
    const __prev_start = window.startEngineAt;
    if (typeof __prev_start === 'function'){
      window.startEngineAt = function(t){
        __prev_start(t);
        try{ if(!window.playSeqOrder || (window.quickLoop && window.quickLoop.active)) enforceLoopFromRegion(); }catch(_){}
      };
    }
  }catch(_){}

  // Wrap resumeWithUpdatedLoopPreservingPhase to enforce loop state when Playlist AUS
  try{
    const __prev_resume = window.resumeWithUpdatedLoopPreservingPhase;
    if (typeof __prev_resume === 'function'){
      window.resumeWithUpdatedLoopPreservingPhase = function(){
        __prev_resume();
        try{ if(!window.playSeqOrder || (window.quickLoop && window.quickLoop.active)) enforceLoopFromRegion(); }catch(_){}
      };
    }
  }catch(_){}

  // When the playlist toggle is turned OFF, re-apply loops immediately
  try{
    if (typeof playSeqToggle !== 'undefined' && playSeqToggle){
      playSeqToggle.addEventListener('change', ()=>{
        try{ if(!window.playSeqOrder || (window.quickLoop && window.quickLoop.active)) enforceLoopFromRegion(); }catch(_){}
      });
    }
  }catch(_){}
})();

/* ========== Phase-preserving resume guard ========== */
(function(){
  // Guard to prevent "phase-preserving resume" or loop code from undoing a sequence jump
  let __seqGuardUntil = 0;
  function __now(){ try { return performance.now(); } catch(_){ return Date.now(); } }
  function __setSeqGuard(ms){
    __seqGuardUntil = __now() + (ms||250);
  }
  window.__setSeqGuard = __setSeqGuard;

  function __withinGuard(){ return __now() < __seqGuardUntil; }

  // Wrap startEngineAt to establish guard and ensure loop is off when playlist is ON
  try{
    const __orig_start = window.startEngineAt;
    if (typeof __orig_start === 'function'){
      window.startEngineAt = function(t){
        if (window.playSeqOrder) __setSeqGuard(260);
        const r = __orig_start(t);
        try{
          if (window.playSeqOrder && window.engineSource){
            window.engineSource.loop = false;
          }
        }catch(_){}
        return r;
      };
    }
  }catch(_){}

  // If any code tries to "resume with phase" => neutralize while playlist ON
  try{
    const __orig_resume = window.resumeWithUpdatedLoopPreservingPhase;
    if (typeof __orig_resume === 'function'){
      window.resumeWithUpdatedLoopPreservingPhase = function(){
        if (window.playSeqOrder){
          try{
            const t = (typeof getPlayheadTime === 'function') ? getPlayheadTime() : 0;
            __setSeqGuard(280);
            return startEngineAt(t);
          }catch(_){ return; }
        }
        return __orig_resume();
      };
    }
  }catch(_){}

  // Generic wrappers for commonly used loop/apply helpers: no engine restarts while playlist ON
  ['applyLoopAndResume','applyLoop','updateLoopAndResume','applyQuickLoop','applyMarkerLoop'].forEach(fn=>{
    try{
      const __orig = window[fn];
      if (typeof __orig === 'function'){
        window[fn] = function(){
          if (window.playSeqOrder) {
            // Update UI state but don't restart engine
            try { return; } catch(_){ return; }
          }
          return __orig.apply(this, arguments);
        };
      }
    }catch(_){}
  });

  // Safety: during guard window, repeatedly ensure loop is off
  (function antiReassert(){
    try{
      if (window.playSeqOrder && __withinGuard() && window.engineSource){
        window.engineSource.loop = false;
      }
    }catch(_){}
    requestAnimationFrame(antiReassert);
  })();

  // If smoothJumpTo exists globally, wrap to set guard explicitly
  try{
    const __orig_smoothJumpTo = window.smoothJumpTo;
    if (typeof __orig_smoothJumpTo === 'function'){
      window.smoothJumpTo = function(t){
        if (window.playSeqOrder) __setSeqGuard(300);
        return __orig_smoothJumpTo(t);
      };
    }
  }catch(_){}
})();

/* ========== Save patch (merged into currentProject) ========== */
/* Save patch merged into currentProject; wrapper removed to avoid double-wrapping. */

/* ========== Sequenz / Reps ========== */
(function(){
    // Scope-safe; don't rely on globals from other scripts
    const lyricsListEl = document.getElementById('lyricsList');
    if (!lyricsListEl) return;

    const pop = document.getElementById('rhyme-popover');
    const popHeader = document.getElementById('rhyme-popover-header');
    const popBody = document.getElementById('rhyme-popover-body');

    const cache = new Map();
    let currentRange = null;

    // Helpers
    const isWordChar = (ch) => /\p{L}|\p{N}|['’-]/u.test(ch);
    function expandRangeToWord(range) {
      // Allow collapsed or small selection inside a word
      if (!range) return null;
      let node = range.startContainer;
      if (node.nodeType !== Node.TEXT_NODE) {
        if (node.childNodes && node.childNodes.length && range.startOffset > 0) {
          node = node.childNodes[Math.max(0, range.startOffset - 1)];
        }
      }
      if (node && node.nodeType !== Node.TEXT_NODE) return null;
      const text = node.textContent;
      if (!text) return null;
      let i = range.startOffset, j = range.startOffset;
      while (i > 0 && isWordChar(text[i-1])) i--;
      while (j < text.length && isWordChar(text[j])) j++;
      const word = text.slice(i, j);
      if (!word || !/\p{L}/u.test(word)) return null;
      const wordRange = document.createRange();
      wordRange.setStart(node, i);
      wordRange.setEnd(node, j);
      return { word, wordRange };
    }
    function caretRectFromRange(wordRange) {
      const marker = document.createElement('span');
      marker.textContent = '\u200b';
      wordRange.insertNode(marker);
      const rect = marker.getBoundingClientRect();
      marker.remove();
      return rect;
    }
    function matchCaseLike(src, candidate) {
      if (!src) return candidate;
      if (src[0] === src[0].toUpperCase() && src.slice(1) === src.slice(1).toLowerCase()) {
        return candidate[0]?.toUpperCase() + candidate.slice(1);
      }
      if (src === src.toUpperCase()) return candidate.toUpperCase();
      return candidate;
    }
    function hidePopover() {
      pop.style.display = 'none';
      currentRange = null;
    }
    function placePopover(rect) {
      const pad = 8;
      // Measure pop after making it visible once to get size
      pop.style.display = 'block';
      const w = pop.offsetWidth || 240;
      const x = Math.min(window.innerWidth - w - pad, Math.max(pad, rect.left + window.scrollX));
      const y = rect.bottom + window.scrollY + 10;
      pop.style.left = x + 'px';
      pop.style.top  = y + 'px';
    }

    // Generic JSONP loader for RhymeBrain with language
    function loadRhymes(word, lang) {
      lang = (lang === 'en' ? 'en' : 'de');
      const key = lang + ':' + word.toLowerCase();
      if (cache.has(key)) return Promise.resolve(cache.get(key));
      return new Promise((resolve, reject) => {
        const cb = 'rb_' + Math.random().toString(36).slice(2);
        window[cb] = (data) => {
          try { delete window[cb]; } catch(_) {}
          script.remove();
          cache.set(key, data);
          resolve(data);
        };
        const url = 'https://rhymebrain.com/talk?function=getRhymes'
          + '&lang=' + lang + '&maxResults=60&word=' + encodeURIComponent(word)
          + '&jsonp=' + cb;
        const script = document.createElement('script');
        script.src = url;
        script.onerror = () => { try { delete window[cb]; } catch(_) {} reject(new Error('JSONP failed')); };
        document.body.appendChild(script);
      });
    }
    // JSONP loader for RhymeBrain
    function loadRhymesDE(word) {
      const key = word.toLowerCase();
      if (cache.has(key)) return Promise.resolve(cache.get(key));
      return new Promise((resolve, reject) => {
        const cb = 'rb_' + Math.random().toString(36).slice(2);
        window[cb] = (data) => {
          try { delete window[cb]; } catch(_) {}
          script.remove();
          cache.set(key, data);
          resolve(data);
        };
        const url = 'https://rhymebrain.com/talk?function=getRhymes'
          + '&lang=de&maxResults=60&word=' + encodeURIComponent(key)
          + '&jsonp=' + cb;
        const script = document.createElement('script');
        script.src = url;
        script.onerror = () => { try { delete window[cb]; } catch(_) {} reject(new Error('JSONP failed')); };
        document.body.appendChild(script);
      });
    }

    function renderRhymes(word, results) {
      const perfect = results.filter(r => +r.score >= 300);
      const near    = results.filter(r => +r.score < 300);

      const pill = (w, score) =>
        '<button type="button" class="r-pill" data-word="' + w + '" data-score="' + score + '"'
        + ' style="margin:6px; padding:6px 10px; border:1px solid #303030; border-radius:999px; background:#1e1e1e; color:#e2e2e2; cursor:pointer;">'
        + w + '</button>';

      let html = '';
      if (perfect.length) {
        html += '<div style="padding:8px 10px; font-size:12px; color:#90caf9;">Perfekte Reime</div>';
        html += '<div style="display:flex; flex-wrap:wrap; padding:0 6px 6px 6px;">' + perfect.slice(0,24).map(r => pill(r.word, r.score)).join('') + '</div>';
      }
      if (near.length) {
        html += '<div style="padding:8px 10px; font-size:12px; color:#9e9e9e;">Nahe Reime</div>';
        html += '<div style="display:flex; flex-wrap:wrap; padding:0 6px 10px 6px;">' + near.slice(0,24).map(r => pill(r.word, r.score)).join('') + '</div>';
      }
      if (!perfect.length && !near.length) {
        html = '<div style="padding:12px 10px; color:#9e9e9e;">Keine Vorschläge gefunden.</div>';
      }
      popHeader.textContent = 'Reime zu „' + word + '“';
      popBody.innerHTML = html;
      pop.style.display = 'block';
    }

    // Event delegation: click inside any .line within #lyricsList
    lyricsListEl.addEventListener('mouseup', (e) => {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) { hidePopover(); return; }
      const range = sel.getRangeAt(0);
      // Must be within a line
      const lineEl = (range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement
      )?.closest?.('.line');
      if (!lineEl || !lyricsListEl.contains(lineEl)) { hidePopover(); return; }
      if (!range.collapsed) { hidePopover(); return; } // caret click only

      const expanded = expandRangeToWord(range);
      if (!expanded) { hidePopover(); return; }

      const { word, wordRange } = expanded;
      currentRange = wordRange;
      const rect = caretRectFromRange(wordRange);
      popHeader.textContent = 'Lade Reime …';
      popBody.innerHTML = '<div style="padding:12px 10px; color:#9e9e9e;">Suche …</div>';
      placePopover(rect);

      (function(){
        const mode = (window.RHYME_MODE === 'off') ? 'off' : (window.RHYME_MODE === 'en' ? 'en' : 'de');
        if (mode === 'off') { hidePopover(); return Promise.reject('off'); }
        return loadRhymes(word, mode).then(data => renderRhymes(word, data));
      })()
        .then(()=>{})
        .catch(() => {
          popHeader.textContent = 'Reime zu „' + word + '“';
          popBody.innerHTML = '<div style="padding:12px 10px; color:#ef4444;">Fehler beim Laden.</div>';
        });
    });

    // Insert rhyme on click
    pop.addEventListener('click', (e) => {
      const btn = e.target.closest('.r-pill');
      if (!btn || !currentRange) return;
      const newWord = btn.getAttribute('data-word');
      const oldWord = currentRange.toString();
      const replacement = matchCaseLike(oldWord, newWord);
      const lineEl = currentRange.startContainer?.parentElement?.closest?.('.line') || null;
      currentRange.deleteContents();
      currentRange.insertNode(document.createTextNode(replacement));
      if (lineEl) {
        // ensure the model syncs if your app listens for input events
        try { lineEl.dispatchEvent(new InputEvent('input', { bubbles: true })); } catch(_) {}
      }
      hidePopover();
    });

    // Close on outside click / escape / scroll / resize
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hidePopover(); });
    document.addEventListener('mousedown', (e) => {
      if (!pop.contains(e.target) && !e.target.closest('#lyricsList')) hidePopover();
    }, { capture: true });
    window.addEventListener('scroll', hidePopover, { passive: true });
    window.addEventListener('resize', hidePopover);
  })();

/* ========== Export-Modal ========== */
(function(){
  // Wait for DOM and previous scripts to be ready
  function ready(fn){ if(document.readyState !== 'loading') fn(); else document.addEventListener('DOMContentLoaded', fn); }
  ready(function(){
    try{
      // These are defined in the main script
      const lblDefault = 'Sortiere Marker per Drag and Drop. Bei Aktivierung wird diese Reihenfolge gespielt.';
      const lblLocked  = 'Marker-Loop aktiv – Zum Aktivieren von Custom Arrangement die Checkbox ankreuzen (aktive Marker werden dann deaktiviert).';

      function updateArrangementLock(){
        try{
          // "getActiveMarkersSorted" returns up to the first 2 active markers sorted by time
          const isMarkerLoop = (typeof getActiveMarkersSorted === 'function') && getActiveMarkersSorted().length === 2;
          if(isMarkerLoop){
            // turn off and lock the custom arrangement
            if(typeof playSeqOrder !== 'undefined') playSeqOrder = false;
            if(window.playSeqToggle){
              playSeqToggle.checked = false;
              try{ playSeqToggle.closest('label')?.classList.remove('active'); }catch(_){}
            }
            if(window.seqInfo){
              seqInfo.textContent = lblLocked;
              seqInfo.style.opacity = '0.7';
            }
          }else{
            // unlock branch: nichts weiter nötig (Checkbox bleibt stets aktiv)
            if(window.seqInfo){
              seqInfo.textContent = lblDefault;
              seqInfo.style.opacity = '0.9';
            }
          }
          // keep audio engine/looping logic in sync
          try{ if(window.usingEngine) resumeWithUpdatedLoopPreservingPhase(); }catch(_){}
          try{ if(typeof draw === 'function') draw(); }catch(_){}
        }catch(e){ console.warn('updateArrangementLock error', e); }
      }
      window.updateArrangementLock = updateArrangementLock;

      // Make sure any UI rebuild also refreshes the lock
      function patchRenderMarkerList(){
        if(typeof window.renderMarkerList === 'function' && !window.renderMarkerList.__patchedByLoopLock){
          const __old = window.renderMarkerList;
          window.renderMarkerList = function(){
            const r = __old.apply(this, arguments);
            try{ updateArrangementLock(); }catch(_){}
            return r;
          };
          window.renderMarkerList.__patchedByLoopLock = true;
        }
      }
      patchRenderMarkerList();
      // Late patch if renderMarkerList is defined later
      const tryPatchTimer = setInterval(()=>{
        try{
          patchRenderMarkerList();
          // When markers exist and the function is patched, we can stop trying
          if(window.renderMarkerList && window.renderMarkerList.__patchedByLoopLock){ clearInterval(tryPatchTimer); }
        }catch(_){}
      }, 200);

      // Guard the checkbox itself: implement PingPong behavior
      if(window.playSeqToggle){
        playSeqToggle.addEventListener('change', function(){
          try{
            const isLoop = (typeof getActiveMarkersSorted === 'function') && getActiveMarkersSorted().length === 2;
            if(this.checked){
              // User wants Custom Arrangement ON
              if(isLoop){
                // PingPong: aktive Marker deaktivieren und dann Arrangement aktivieren
                try{
                  if(Array.isArray(window.markers)){
                    window.markers.forEach(m => { if(m && m.active) m.active = false; });
                    if(typeof window.renderMarkerList === 'function') window.renderMarkerList();
                  }
                }catch(_){}
              }
              if(typeof playSeqOrder !== 'undefined') playSeqOrder = true;
            }else{
              // Checkbox OFF
              if(typeof playSeqOrder !== 'undefined') playSeqOrder = false;
            }
            try{ if(window.usingEngine) resumeWithUpdatedLoopPreservingPhase(); }catch(_){}
            try{ if(typeof draw === 'function') draw(); }catch(_){}
          }catch(_){}
        });
      }

      // Initial sync
      updateArrangementLock();
      // Also re-check on window focus changes (paranoid but cheap)
      window.addEventListener('focus', updateArrangementLock);
    }catch(e){
      console.warn('Arrangement lock init failed:', e);
    }
  });
  try{ updateMarkerRowHighlight(cursorTime); }catch(_){}
})();

/* ========== Info-Badge Modal ========== */
(function(){
  const badge = document.getElementById('infoBadge');
  const modal = document.getElementById('infoModal');
  const closeBtn = document.getElementById('infoClose');
  const okBtn = document.getElementById('infoOk');

  function openModal(){
    if(!modal) return;
    modal.style.display = 'flex';
    // focus close for accessibility
    try{ closeBtn && closeBtn.focus(); }catch(_){}
    document.addEventListener('keydown', onKey);
  }
  function closeModal(){
    if(!modal) return;
    modal.style.display = 'none';
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e){
    if(e.key === 'Escape'){ closeModal(); }
  }

  badge && badge.addEventListener('click', openModal);
  closeBtn && closeBtn.addEventListener('click', closeModal);
  okBtn && okBtn.addEventListener('click', closeModal);
  // backdrop click
  modal && modal.addEventListener('click', (e)=>{
    if(e.target === modal) closeModal();
  });
})();

/* ========== grid-help-styles Script (makeQSvg) ========== */
(function(){
  function makeQSvg(){
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("aria-hidden", "true");
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx","12"); circle.setAttribute("cy","12"); circle.setAttribute("r","10");
    circle.setAttribute("fill","#90caf9");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d","M9.6 9.3a2.4 2.4 0 1 1 3.9 1.8c-.8.6-1.2 1-1.2 2");
    path.setAttribute("stroke","#1e1e1e"); path.setAttribute("stroke-width","1.8"); path.setAttribute("stroke-linecap","round");
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("cx","12"); dot.setAttribute("cy","16.6"); dot.setAttribute("r","1.1"); dot.setAttribute("fill","#1e1e1e");
    svg.appendChild(circle); svg.appendChild(path); svg.appendChild(dot);
    return svg;
  }

  function ensureHelpModal(){
    if(document.getElementById("helpModal")) return document.getElementById("helpModal");
    const modal = document.createElement("div");
    modal.id = "helpModal";
    modal.className = "modal-backdrop info-modal help-modal";
    modal.style.display = "none";
    modal.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="helpTitle">
        <div class="modal-header">
          <div id="helpTitle" class="modal-title">Waveform</div>
          <button id="helpClose" class="btn btn-sm" aria-label="Schließen">Schließen</button>
        </div>
        <div class="modal-body">
          <pre>
Lade deine Audiodatei und bestimme BPM Tempo und Taktart. 

Verschiebe den Cursor per Drag & Drop, oder mit Taps in der Timeline. 

Zoome und scrolle mit Fingergesten. 

Kürze leere Stellen am Anfang oder Ende mit den Trim Buttons.

Deaktiviere die Snap Grid Magnetfunktion für mehr Präzision.
          </pre>
        </div>
      </div>`;
    document.body.appendChild(modal);
    function close(){ modal.style.display = "none"; }
    modal.addEventListener("click", (e)=>{ if(e.target === modal) close(); });
    document.addEventListener("keydown", (e)=>{ if(e.key === "Escape") close(); });
    modal.querySelector("#helpClose").addEventListener("click", close);
    return modal;
  }

  function init(){
    const snap = document.getElementById("gridSnapBtn");
    if(!snap) return;
    const btn = document.createElement("button");
    btn.id = "gridHelp";
    btn.className = "help-badge";
    btn.title = "Kurzanleitung";
    btn.setAttribute("aria-label","Kurzanleitung");
    btn.appendChild(makeQSvg());
    snap.insertAdjacentElement("afterend", btn);

    const modal = ensureHelpModal();
    btn.addEventListener("click", ()=> { modal.style.display = "flex"; });
  }

  if(document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", init);
  }else{
    init();
  }
})();

/* ========== Marker-Help Modal ========== */
(function(){
  const modal = document.getElementById('markerHelpModal');
  const openBtn = document.getElementById('markerHelp');
  const close1 = document.getElementById('markerHelpClose');
  const close2 = document.getElementById('markerHelpClose2');
  function open(){ if(modal) modal.style.display='flex'; }
  function close(){ if(modal) modal.style.display='none'; }
  openBtn && openBtn.addEventListener('click', open);
  close1 && close1.addEventListener('click', close);
  close2 && close2.addEventListener('click', close);
  modal && modal.addEventListener('click', (e)=>{ if(e.target===modal) close(); });
})();

/* ========== Seq-Help Modal ========== */
(function(){
  const btn = document.getElementById('seqHelp');
  const modal = document.getElementById('seqHelpModal');

  function openModal(){
    if(!modal) return;
    modal.style.display = 'flex';
  }
  function closeModal(){
    if(!modal) return;
    modal.style.display = 'none';
  }

  if(btn){
    btn.addEventListener('click', function(e){
      e.stopPropagation();
      openModal();
    });
  }
  if(modal){
    modal.addEventListener('click', function(e){
      // Click on backdrop closes; ignore clicks inside the card
      const card = modal.querySelector('.modal-card');
      if(!card || !card.contains(e.target)) closeModal();
    });
  }
  // ESC to close
  window.addEventListener('keydown', function(e){
    if(e.key === 'Escape'){
      closeModal();
    }
  });

  // Close button inside modal header
  if(modal){
    const cbtn = modal.querySelector('.modal-close, .btn-close');
    if(cbtn){
      cbtn.addEventListener('click', function(e){
        e.stopPropagation();
        closeModal();
      });
    }
  }

})();

/* ========== editor-help-v2-script ========== */
(function(){
  const btn = document.getElementById('editorHelp');
  const modal = document.getElementById('editorHelpModal');
  const close1 = document.getElementById('editorHelpClose');
  const close2 = document.getElementById('editorHelpClose2');
  function open(){ if(modal) modal.style.display = 'flex'; }
  function close(){ if(modal) modal.style.display = 'none'; }
  btn && btn.addEventListener('click', open);
  close1 && close1.addEventListener('click', close);
  close2 && close2.addEventListener('click', close);
  modal && modal.addEventListener('click', (e)=>{ if(e.target === modal) close(); });
})();

/* ========== DOMContentLoaded – Schließen-Button entfernen ========== */
document.addEventListener('DOMContentLoaded', function(){
  // Remove bottom "Schließen" buttons specifically (keep top X intact)
  const modal = document.querySelector('#editorHelpModal');
  if(modal){
    const candidates = modal.querySelectorAll('.modal-footer button, .modal-card-foot button, .modal-actions button, footer button, .modal-footer a, .modal-card-foot a, .modal-actions a, footer a');
    candidates.forEach(el=>{
      const txt = (el.textContent || '').trim().toLowerCase();
      if (txt === 'schließen' || txt === 'schliessen' || txt === 'close'){
        el.remove();
      }
    });
  }
});


