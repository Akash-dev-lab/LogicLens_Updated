import { useState, useRef, useEffect } from 'react';
import Editor from '@monaco-editor/react';
import { instrumentCode } from './engine/instrument';
import { extractStaticVariables } from './engine/preview';
import './App.css';
import { Play, Pause, RotateCcw, Microscope, ChevronRight, ChevronLeft, ChevronDown, ChevronUp } from 'lucide-react';
import { snippets } from './snippets';

function App() {
  const [code, setCode] = useState(`let arr = [10, 20, 30];
let sum = 0;
for (let i = 0; i < arr.length; i++) {
  sum = sum + arr[i];
}`);
  const [isRunning, setIsRunning] = useState(false);
  const [frames, setFrames] = useState([]);
  const [currentStep, setCurrentStep] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false); // NEW: Auto-play state
  const [speed, setSpeed] = useState(800);
  // const currentLogs = frames.length > 0 ? frames[currentStep].logs : [];
  const [isConsoleOpen, setIsConsoleOpen] = useState(true);
  const [previewVars, setPreviewVars] = useState(() => extractStaticVariables(`let arr = [10, 20, 30];
let sum = 0;
for (let i = 0; i < arr.length; i++) {
  sum = sum + arr[i];
}`));

  // Debounced static variable extraction on code change
  useEffect(() => {
    const timer = setTimeout(() => {
      setPreviewVars(extractStaticVariables(code));
    }, 150);

    return () => clearTimeout(timer);
  }, [code]);

  // NEW: Auto-play effect
  useEffect(() => {
    if (isPlaying) {
      // If we reach the end, stop playing
      if (currentStep >= frames.length - 1) {
        setIsPlaying(false);
        return;
      }

      // Set a timer to advance to the next step
      const timer = setTimeout(() => {
        setCurrentStep(prev => prev + 1);
      }, speed); // Use speed state here

      // Cleanup timer if component unmounts or step changes manually
      return () => clearTimeout(timer);
    }
  }, [isPlaying, currentStep, frames]);

  // Refs for Monaco Editor to control line highlighting
  const editorRef = useRef(null);
  const decorationsRef = useRef([]);

  const handleEditorDidMount = (editor, monaco) => {
    editorRef.current = editor;
  };

  // This effect runs whenever the user steps forward/backward
  useEffect(() => {
    if (editorRef.current && frames.length > 0) {
      const currentLine = frames[currentStep].line;

      // Clear old highlight, add new one
      decorationsRef.current = editorRef.current.deltaDecorations(decorationsRef.current, [
        {
          range: { startLineNumber: currentLine, endLineNumber: currentLine, startColumn: 1, endColumn: 1 },
          options: {
            isWholeLine: true,
            className: 'line-highlight', // We will style this in CSS
            glyphClass: 'line-glyph'     // A little arrow in the margin
          }
        }
      ]);

      // Scroll to the line if it's off-screen
      editorRef.current.revealLineInCenter(currentLine);
    }
  }, [currentStep, frames]);

  const handleRun = (codeToRun = code) => {
    setIsPlaying(false);
    setIsRunning(true);
    try {
      const instrumentedCode = instrumentCode(codeToRun);
      const worker = new Worker(new URL('./simulator.worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = (e) => {
        if (e.data.type === 'finished') {
          setFrames(e.data.frames);
          setCurrentStep(0);
        } else if (e.data.type === 'error') {
          console.error("Worker Error:", e.data.message);
        }
        setIsRunning(false);
        worker.terminate();
      };
      worker.postMessage({ instrumentedCode });
    } catch (error) {
      console.error("Parsing Error:", error);
      setIsRunning(false);
    }
  };

  const handleSnippetChange = (e) => {
    const selectedName = e.target.value;
    if (selectedName === "None") {
      setCode(`// Write your JavaScript code here...`);
      setFrames([]); // Clear simulation
      setCurrentStep(0);
      return;
    }

    const selectedSnippet = snippets.find(s => s.name === selectedName);
    if (selectedSnippet) {
      setCode(selectedSnippet.code);
      handleRun(selectedSnippet.code);
    }
  };

  const handleStepForward = () => {
    if (currentStep < frames.length - 1) setCurrentStep(prev => prev + 1);
  };

  // NEW: Step Backward function
  const handleStepBackward = () => {
    if (currentStep > 0) setCurrentStep(prev => prev - 1);
  };

  const handleReset = () => {
    setCurrentStep(0);
    // Clear decorations on reset
    if (editorRef.current) {
      decorationsRef.current = editorRef.current.deltaDecorations(decorationsRef.current, []);
    }
  };

  const handlePlayPause = () => {
    // If at the end, restart from beginning before playing
    if (currentStep >= frames.length - 1) {
      setCurrentStep(0);
      // Only start playing if we aren't at the end, or if we just reset
      if (!isPlaying) setIsPlaying(true);
    } else {
      setIsPlaying(prev => !prev);
    }
  };

  const currentMemory = frames.length > 0 ? frames[currentStep].memory : {};
  const currentStack = frames.length > 0 ? frames[currentStep].stack : [];
  const currentEvent = frames.length > 0 ? frames[currentStep].event : null;
  const currentLogs = frames.length > 0 ? frames[currentStep].logs : [];
  const prevMemory = currentStep > 0 ? frames[currentStep - 1].memory : {};

  // ── helper: detect 2-D matrix (array of arrays) ──────────────────────────
  const isMatrix = (val) =>
    Array.isArray(val) && val.length > 0 && Array.isArray(val[0]);

  // Name hints to classify pointer as row-pointer vs col-pointer in 2-D arrays
  const ROW_HINTS = new Set(['top','bottom','row','r','i','startrow','endrow','rowstart','rowend']);
  const COL_HINTS = new Set(['left','right','col','c','j','startcol','endcol','colstart','colend']);

  // Statically inferred target array from preview (for 1-D loop pointer targeting)
  const staticTargetMap = {};
  previewVars.forEach(v => { if (v.targetArray) staticTargetMap[v.name] = v.targetArray; });

  // Build pointer map for ALL arrays — supports 1-D and 2-D
  const arrayPointerMap = {};
  const attachedPointers = new Set();

  // ALL integer variables in current memory are candidates
  const intVars = Object.entries(currentMemory)
    .filter(([, v]) => typeof v === 'number' && Number.isInteger(v))
    .map(([name, value]) => ({ name, value }));

  const arrayNamesInMem = Object.keys(currentMemory).filter(k => Array.isArray(currentMemory[k]));

  arrayNamesInMem.forEach(arrName => {
    const arr = currentMemory[arrName];

    if (isMatrix(arr)) {
      // 2-D: classify each int variable as row or col pointer by name hint + range
      const numRows = arr.length;
      const numCols = Math.max(...arr.map(r => Array.isArray(r) ? r.length : 0), 0);
      const rowPtrs = [], colPtrs = [];

      intVars.forEach(({ name, value }) => {
        if (name === arrName || attachedPointers.has(name)) return;
        const lname = name.toLowerCase();
        const rowHint = ROW_HINTS.has(lname);
        const colHint = COL_HINTS.has(lname);
        const inRow = value >= 0 && value < numRows;
        const inCol = value >= 0 && value < numCols;
        if (rowHint && inRow)        { rowPtrs.push({ name, index: value }); attachedPointers.add(name); }
        else if (colHint && inCol)   { colPtrs.push({ name, index: value }); attachedPointers.add(name); }
        else if (!rowHint && !colHint) {
          if (inRow && !inCol)       { rowPtrs.push({ name, index: value }); attachedPointers.add(name); }
          else if (inCol && !inRow)  { colPtrs.push({ name, index: value }); attachedPointers.add(name); }
        }
      });
      arrayPointerMap[arrName] = { matrix: true, rowPtrs, colPtrs };

    } else {
      // 1-D: only variables whose name looks like an index/pointer are candidates
      // (prevents temp, sum, count, ans, result, etc. from showing as pointers)
      const PTR_HINTS_1D = new Set([
        // single letters commonly used as loop/pointer vars
        'i','j','k','l','r','p','q',
        // named pointers
        'left','right','top','bottom','start','end','mid','middle',
        'lo','hi','low','high','front','rear','head','tail',
        'ptr','pos','idx','index','curr','current','prev','next',
        'slow','fast','pivot','partition','minidx','maxidx',
        'startidx','endidx','startptr','endptr',
      ]);
      const ptrs = [];
      intVars.forEach(({ name, value }) => {
        if (name === arrName || attachedPointers.has(name)) return;
        if (!PTR_HINTS_1D.has(name.toLowerCase())) return; // skip non-pointer names
        const preferred = staticTargetMap[name];
        if (preferred && preferred !== arrName) return;
        if (value >= 0 && value <= arr.length) {
          ptrs.push({ name, index: value });
          attachedPointers.add(name);
        }
      });
      arrayPointerMap[arrName] = { matrix: false, ptrs };
    }
  });

  // Helper: active indices for 1-D arrays
  const getActiveIndicesForArray = (arrName) => {
    const info = arrayPointerMap[arrName];
    if (!info || info.matrix) return [];
    return info.ptrs.map(p => p.index);
  };

  return (
    <div className="app-container">
      <header className="header">
        <div className="logo-and-snippets">
          <div className="logo">
            <Microscope size={24} className="logo-icon" />
            <h1>Logic<span>Lens</span></h1>
          </div>

          {/* NEW: Snippets Dropdown */}
          <select
            onChange={handleSnippetChange}
            defaultValue=""
            className="snippets-dropdown"
          >
            <option value="" disabled>Load Example...</option>
            {snippets.map((snippet, index) => (
              <option key={index} value={snippet.name}>
                {snippet.name}
              </option>
            ))}
          </select>
        </div>

        <div className="controls">
          {/* 1. Simulate Button */}
          <button onClick={() => handleRun()} disabled={isRunning} className="control-btn primary" title="Run Simulation">
            {isRunning ? 'Simulating...' : 'Simulate'}
          </button>

          <div style={{ width: '1px', height: '24px', background: '#30363d', margin: '0 8px' }}></div>

          {/* 2. Speed Slider with Text (0.5x to 2.0x) */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '12px', color: '#8b949e', minWidth: '40px', textAlign: 'right' }}>
              {(800 / speed).toFixed(2)}x
            </span>
            <input
              type="range"
              min="400"
              max="1600"
              value={2000 - speed}
              onChange={(e) => setSpeed(2000 - Number(e.target.value))}
              disabled={frames.length === 0}
            />
          </div>

          <div style={{ width: '1px', height: '24px', background: '#30363d', margin: '0 8px' }}></div>

          {/* 3. Playback Controls */}
          <button onClick={handleReset} disabled={frames.length === 0} className="control-btn secondary" title="Reset">
            <RotateCcw size={16} />
          </button>
          <button onClick={handleStepBackward} disabled={currentStep === 0 || isPlaying} className="control-btn secondary" title="Step Backward">
            <ChevronLeft size={16} />
          </button>
          <button onClick={handlePlayPause} disabled={frames.length === 0} className="control-btn secondary" title="Play/Pause">
            {isPlaying ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
          </button>
          <button onClick={handleStepForward} disabled={currentStep >= frames.length - 1 || isPlaying} className="control-btn secondary" title="Step Forward">
            <ChevronRight size={16} />
          </button>
        </div>
      </header>

      <main className="main-content">
        <div className="editor-pane">
          <div className="pane-header"><span>script.js</span></div>
          <Editor
            height="100%"
            defaultLanguage="javascript"
            value={code}
            onChange={(value) => {
              setCode(value);
              setFrames([]);
              setCurrentStep(0);
              setIsPlaying(false);
            }}
            onMount={handleEditorDidMount}
            theme="vs-dark"
            options={{
              fontSize: 14,
              minimap: { enabled: false },
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
              fontFamily: '"JetBrains Mono", monospace',
            }}
          />
        </div>

        <div className="visualizer-pane">
          {/* Top Right: Memory & Variables (45% height) */}
          <div className="viz-section memory-section">
            <div className="pane-header">
              <span>Memory & Variables</span>
              {frames.length > 0 && (
                <span className="step-indicator">Step {currentStep + 1} / {frames.length}</span>
              )}
            </div>
            <div className="viz-content">
              {frames.length === 0 ? (
                previewVars.length > 0 ? (
                  <div className="memory-grid">
                    {previewVars.map((item) => {
                      if (item.type === 'array') {
                        const previewLabel = (
                          <div className="var-label">
                            {item.name} <span className="preview-tag">live preview</span>
                          </div>
                        );

                        // ── 2-D matrix grid in live preview ──────────────────
                        const isPreviewMatrix = item.value.length > 0 && Array.isArray(item.value[0]);
                        if (isPreviewMatrix) {
                          const numCols = Math.max(...item.value.map(r => Array.isArray(r) ? r.length : 0), 0);
                          return (
                            <div key={`preview-${item.name}`} className="memory-item matrix-container preview-mode">
                              {previewLabel}
                              <div className="matrix-table-wrap">
                                <div className="matrix-row matrix-header-row">
                                  <div className="matrix-row-label matrix-corner" />
                                  {Array.from({ length: numCols }, (_, ci) => (
                                    <div key={ci} className="matrix-col-idx">{ci}</div>
                                  ))}
                                </div>
                                {item.value.map((row, ri) => (
                                  <div key={ri} className="matrix-row">
                                    <div className="matrix-row-label">
                                      <span className="matrix-row-idx">{ri}</span>
                                    </div>
                                    {Array.from({ length: numCols }, (_, ci) => {
                                      const cellVal = Array.isArray(row) && ci < row.length ? row[ci] : '';
                                      return (
                                        <div key={ci} className="matrix-cell">
                                          {JSON.stringify(cellVal)}
                                        </div>
                                      );
                                    })}
                                  </div>
                                ))}
                              </div>
                            </div>
                          );
                        }

                        // ── 1-D array in live preview (existing) ─────────────
                        const loopPointers = previewVars.filter(
                          v => v.isLoopPointer && v.targetArray === item.name && typeof v.value === 'number'
                        );
                        return (
                          <div key={`preview-${item.name}`} className="memory-item array-container preview-mode">
                            {previewLabel}
                            <div className="array-box">
                              {item.value.length === 0 ? (
                                <div className="array-item empty-array-item">
                                  <span className="array-index">empty</span>
                                  <span className="array-value">[]</span>
                                </div>
                              ) : (
                                item.value.map((elem, index) => {
                                  const matchingPointers = loopPointers.filter(p => p.value === index);
                                  const isPointerActive = matchingPointers.length > 0;
                                  return (
                                    <div key={index} className={`array-item ${isPointerActive ? 'active-index' : ''}`}>
                                      <span className="array-index">{index}</span>
                                      <span className="array-value">{JSON.stringify(elem)}</span>
                                      {matchingPointers.length > 0 && (
                                        <div className="array-cell-pointer-container">
                                          {matchingPointers.map(p => (
                                            <div key={p.name} className="array-pointer-badge">
                                              <span className="array-pointer-arrow">▲</span>
                                              <span className="array-pointer-name">{p.name}</span>
                                            </div>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })
                              )}
                            </div>
                          </div>
                        );
                      }

                      // Do NOT show separate card if it is already rendered as an array pointer
                      if (item.isLoopPointer && item.targetArray) {
                        return null;
                      }

                      return (
                        <div key={`preview-${item.name}`} className="memory-item var-box preview-mode">
                          <span className="var-name">
                            {item.name} <span className="preview-tag">preview</span>
                          </span>
                          <span className="var-value">{JSON.stringify(item.value)}</span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="empty-state">Click "Simulate" to begin tracing memory.</div>
                )
              ) : (
                <div className="memory-grid">
                  {Object.entries(currentMemory).map(([name, value]) => {
                    const hasChanged = JSON.stringify(prevMemory[name]) !== JSON.stringify(value);
                    const flashClass = hasChanged ? 'flash-highlight' : '';
                    const dynamicKey = `${name}-${JSON.stringify(value)}`;

                    if (Array.isArray(value)) {
                      const ptrInfo = arrayPointerMap[name] || { matrix: false, ptrs: [] };

                      // ── 2-D matrix grid view ──────────────────────────────
                      if (ptrInfo.matrix) {
                        const numRows = value.length;
                        const numCols = Math.max(...value.map(r => Array.isArray(r) ? r.length : 0), 0);
                        const { rowPtrs, colPtrs } = ptrInfo;
                        const activeRows = new Set(rowPtrs.map(p => p.index));
                        const activeCols = new Set(colPtrs.map(p => p.index));
                        return (
                          <div key={dynamicKey} className={`memory-item matrix-container ${flashClass}`}>
                            <div className="var-label">{name}</div>
                            <div className="matrix-table-wrap">
                              {/* Column index header */}
                              <div className="matrix-row matrix-header-row">
                                <div className="matrix-row-label matrix-corner" />
                                {Array.from({ length: numCols }, (_, ci) => (
                                  <div key={ci} className={`matrix-col-idx ${activeCols.has(ci) ? 'active-col-idx' : ''}`}>{ci}</div>
                                ))}
                              </div>
                              {/* Data rows */}
                              {value.map((row, ri) => {
                                const rowActive = activeRows.has(ri);
                                const rowBadges = rowPtrs.filter(p => p.index === ri);
                                return (
                                  <div key={ri} className={`matrix-row${rowActive ? ' matrix-row-active' : ''}`}>
                                    <div className="matrix-row-label">
                                      <span className="matrix-row-idx">{ri}</span>
                                      {rowBadges.map(p => (
                                        <span key={p.name} className="matrix-row-pointer-badge">{p.name}</span>
                                      ))}
                                    </div>
                                    {Array.from({ length: numCols }, (_, ci) => {
                                      const cellVal = Array.isArray(row) && ci < row.length ? row[ci] : '';
                                      const colActive = activeCols.has(ci);
                                      const isIntersect = rowActive && colActive;
                                      return (
                                        <div key={ci} className={`matrix-cell${rowActive ? ' matrix-cell-row-active' : ''}${colActive ? ' matrix-cell-col-active' : ''}${isIntersect ? ' matrix-cell-intersection' : ''}`}>
                                          {JSON.stringify(cellVal)}
                                        </div>
                                      );
                                    })}
                                  </div>
                                );
                              })}
                              {/* Column pointer badges at bottom */}
                              {colPtrs.length > 0 && (
                                <div className="matrix-row matrix-ptr-row">
                                  <div className="matrix-row-label" />
                                  {Array.from({ length: numCols }, (_, ci) => {
                                    const badges = colPtrs.filter(p => p.index === ci);
                                    return (
                                      <div key={ci} className="matrix-col-ptr-cell">
                                        {badges.map(p => (
                                          <span key={p.name} className="matrix-col-pointer-badge">▲ {p.name}</span>
                                        ))}
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      }

                      // ── 1-D array view ────────────────────────────────────
                      const activeArrayIndices = getActiveIndicesForArray(name);
                      const pointersForThisArray = ptrInfo.ptrs || [];
                      const outOfBoundsPointers = pointersForThisArray.filter(
                        p => p.index >= value.length || p.index < 0
                      );
                      return (
                        <div key={dynamicKey} className={`memory-item array-container ${flashClass}`}>
                          <div className="var-label">{name}</div>
                          <div className="array-box">
                            {value.map((item, index) => {
                              const matchingPointers = pointersForThisArray.filter(p => p.index === index);
                              return (
                                <div
                                  key={index}
                                  className={`array-item ${activeArrayIndices.includes(index) ? 'active-index' : ''}`}
                                >
                                  <span className="array-index">{index}</span>
                                  <span className="array-value">{JSON.stringify(item)}</span>
                                  {matchingPointers.length > 0 && (
                                    <div className="array-cell-pointer-container">
                                      {matchingPointers.map(p => (
                                        <div key={p.name} className="array-pointer-badge">
                                          <span className="array-pointer-arrow">▲</span>
                                          <span className="array-pointer-name">{p.name}</span>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                          {outOfBoundsPointers.length > 0 && (
                            <div className="loop-exit-badge">
                              <span className="loop-exit-dot"></span>
                              <span>{outOfBoundsPointers.map(p => `${p.name} = ${p.index} (loop exit)`).join(', ')}</span>
                            </div>
                          )}
                        </div>
                      );
                    }

                    // Do NOT show separate primitive card if it is attached as an active array pointer
                    if (attachedPointers.has(name)) {
                      return null;
                    }

                    if (typeof value === 'object' && value !== null) {
                      return (
                        <div key={dynamicKey} className={`memory-item object-container ${flashClass}`}>
                          <div className="var-label">{name}</div>
                          <div className="object-box">
                            {Object.entries(value).map(([key, val]) => (
                              <div key={key} className="object-property">
                                <span className="prop-key">{key}:</span>
                                <span className="prop-value">{JSON.stringify(val)}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div key={dynamicKey} className={`memory-item var-box ${flashClass}`}>
                        <span className="var-name">{name}</span>
                        <span className="var-value">{JSON.stringify(value)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Middle Right: Call Stack (25% height) */}
          <div className="viz-section stack-section">
            <div className="pane-header"><span>Call Stack</span></div>
            <div className="viz-content">
              {currentStack.length === 0 ? (
                <div className="empty-state">No active functions.</div>
              ) : (
                <div className="stack-container">
                  {currentStack.map((func, index) => (
                    <div key={index} className="stack-frame">
                      {func.name}({func.args.map(a => JSON.stringify(a)).join(', ')})
                    </div>
                  ))}
                </div>
              )}
              {currentEvent && (
                <div className="event-log">
                  {currentEvent}
                </div>
              )}
            </div>
          </div>

          {/* Bottom Right: Console Output (30% height) */}
          {/* Bottom Right: Console Output (Collapsible) */}
          <div className={`viz-section console-section ${isConsoleOpen ? '' : 'minimized'}`}>
            <div className="pane-header">
              <span>Console</span>
              <button
                onClick={() => setIsConsoleOpen(!isConsoleOpen)}
                className="pane-toggle-btn"
                title={isConsoleOpen ? "Minimize Console" : "Maximize Console"}
              >
                {isConsoleOpen ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
              </button>
            </div>

            {/* Only render the content if the console is open */}
            {isConsoleOpen && (
              <div className="viz-content console-content">
                {currentLogs.length === 0 ? (
                  <div className="empty-state">No output.</div>
                ) : (
                  currentLogs.map((log, index) => (
                    <div key={index} className={`console-line ${log.includes('⚠️') ? 'error-log' : ''}`}>
                      <span className="console-arrow">›</span> {log}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;