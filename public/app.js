const els = {
  modeLabel: document.querySelector("#modeLabel"),
  fileName: document.querySelector("#fileName"),
  batchLabel: document.querySelector("#batchLabel"),
  progressLabel: document.querySelector("#progressLabel"),
  undoLabel: document.querySelector("#undoLabel"),
  groupLabel: document.querySelector("#groupLabel"),
  groupHint: document.querySelector("#groupHint"),
  viewer: document.querySelector("#viewer"),
  emptyState: document.querySelector("#emptyState"),
  mainImage: document.querySelector("#mainImage"),
  cropCanvas: document.querySelector("#cropCanvas"),
  cropTools: document.querySelector("#cropTools"),
  summaryPanel: document.querySelector("#summaryPanel"),
  summaryTitle: document.querySelector("#summaryTitle"),
  summaryHeading: document.querySelector("#summaryHeading"),
  statRemaining: document.querySelector("#statRemaining"),
  statProcessed: document.querySelector("#statProcessed"),
  statQ: document.querySelector("#statQ"),
  statW: document.querySelector("#statW"),
  statE: document.querySelector("#statE"),
  statR: document.querySelector("#statR"),
  resumeButton: document.querySelector("#resumeButton"),
  toast: document.querySelector("#toast")
};

const state = {
  files: [],
  session: null,
  index: 0,
  mode: "browse",
  pendingAction: null,
  ratio: "free",
  crop: null,
  drag: null,
  zoom: 1,
  panX: 0,
  panY: 0,
  panDrag: null,
  busy: false
};

const ratioMap = {
  free: null,
  "1:1": 1,
  "3:4": 3 / 4,
  "16:9": 16 / 9
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function currentFile() {
  return state.files[state.index] || null;
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => {
    els.toast.hidden = true;
  }, 2400);
}

function applyPayload(payload) {
  state.files = payload.files || [];
  state.session = payload.session || null;
  const current = state.session?.currentFile;
  const index = state.files.findIndex((file) => file.name === current);
  state.index = index >= 0 ? index : 0;
  exitCropMode();
  render();
}

async function loadSession() {
  applyPayload(await api("/api/session"));
}

function render() {
  const file = currentFile();
  const session = state.session;
  const stats = session?.stats || {};
  const complete = Boolean(session?.complete);

  els.batchLabel.textContent = session ? `Batch ${session.batch}` : "Batch";
  els.undoLabel.textContent = `Undo ${session?.undoAvailable || 0}`;
  els.groupLabel.textContent = session?.activeGroup
    ? `${session.activeGroup.id} (${session.activeGroup.count})`
    : "Group off";
  els.groupLabel.classList.toggle("active-status", Boolean(session?.activeGroup));
  els.groupHint.classList.toggle("active", Boolean(session?.activeGroup));
  els.progressLabel.textContent = `${state.files.length ? state.index + 1 : 0} / ${state.files.length}`;

  if (!file) {
    els.fileName.textContent = "沒有待處理圖片";
    els.mainImage.hidden = true;
    els.cropCanvas.hidden = true;
    els.emptyState.hidden = false;
    if (complete) showSummary("完成", "本批次已處理完成");
    return;
  }

  els.emptyState.hidden = true;
  els.mainImage.hidden = state.mode === "crop";
  els.cropCanvas.hidden = state.mode !== "crop";
  els.fileName.textContent = file.name;
  if (els.mainImage.dataset.name !== file.name) {
    els.mainImage.dataset.name = file.name;
    els.mainImage.src = `${file.url}&t=${Date.now()}`;
  }
  els.modeLabel.textContent = state.mode === "crop" ? `裁剪模式 ${state.pendingAction === "extract-text" ? "Q" : "W"}` : "瀏覽模式";
  els.cropTools.hidden = state.mode !== "crop";
  renderActionHints();
  applyImageTransform();

  if (session?.paused) {
    showSummary("暫停", "Session 已保存");
  } else if (!complete) {
    hideSummary();
  }

  els.statRemaining.textContent = session?.remaining ?? state.files.length;
  els.statProcessed.textContent = stats.processed || 0;
  els.statQ.textContent = stats.extractText || 0;
  els.statW.textContent = stats.keep || 0;
  els.statE.textContent = stats.reviewLater || 0;
  els.statR.textContent = stats.trashCandidate || 0;
}

function renderActionHints() {
  for (const hint of document.querySelectorAll("[data-action-hint]")) {
    hint.classList.toggle("active", state.mode === "crop" && hint.dataset.actionHint === state.pendingAction);
  }
}

function showSummary(title, heading) {
  const session = state.session;
  const stats = session?.stats || {};
  els.summaryTitle.textContent = title;
  els.summaryHeading.textContent = heading;
  els.statRemaining.textContent = session?.remaining ?? state.files.length;
  els.statProcessed.textContent = stats.processed || 0;
  els.statQ.textContent = stats.extractText || 0;
  els.statW.textContent = stats.keep || 0;
  els.statE.textContent = stats.reviewLater || 0;
  els.statR.textContent = stats.trashCandidate || 0;
  els.summaryPanel.hidden = false;
}

function hideSummary() {
  els.summaryPanel.hidden = true;
}

function moveIndex(delta) {
  if (state.mode !== "browse" || state.files.length === 0) return;
  state.index = Math.max(0, Math.min(state.files.length - 1, state.index + delta));
  resetViewport();
  render();
}

function resetViewport() {
  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  state.panDrag = null;
  applyImageTransform();
}

function applyImageTransform() {
  els.mainImage.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
}

function clampPan() {
  if (state.zoom <= 1) {
    state.panX = 0;
    state.panY = 0;
    return;
  }
  const rect = els.mainImage.getBoundingClientRect();
  const maxX = Math.max(0, (rect.width * (state.zoom - 1)) / 2);
  const maxY = Math.max(0, (rect.height * (state.zoom - 1)) / 2);
  state.panX = Math.max(-maxX, Math.min(maxX, state.panX));
  state.panY = Math.max(-maxY, Math.min(maxY, state.panY));
}

function setZoom(nextZoom) {
  if (state.mode !== "browse") return;
  state.zoom = Math.max(1, Math.min(5, nextZoom));
  clampPan();
  applyImageTransform();
}

function zoomBy(delta) {
  const step = delta > 0 ? 1.12 : 1 / 1.12;
  setZoom(state.zoom * step);
}

function isPointerOnImage(event) {
  if (els.mainImage.hidden || !currentFile()) return false;
  const rect = els.mainImage.getBoundingClientRect();
  return (
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom
  );
}

function setRatio(ratio) {
  state.ratio = ratio;
  for (const button of els.cropTools.querySelectorAll("button")) {
    button.classList.toggle("active", button.dataset.ratio === ratio);
  }
  if (state.crop) {
    const box = normalizeCrop(state.crop);
    state.crop = applyRatio(box, box.x, box.y);
    drawCropCanvas();
  }
}

function enterCropMode(action) {
  const file = currentFile();
  if (!file) return;
  resetViewport();
  state.mode = "crop";
  state.pendingAction = action;
  state.crop = null;
  setRatio("free");
  els.mainImage.onload = () => setupCropCanvas();
  if (els.mainImage.complete) setupCropCanvas();
  render();
}

function exitCropMode() {
  state.mode = "browse";
  state.pendingAction = null;
  state.crop = null;
  state.drag = null;
  els.cropTools.hidden = true;
  els.cropCanvas.hidden = true;
  els.mainImage.hidden = false;
  renderActionHints();
}

function setupCropCanvas() {
  if (state.mode !== "crop") return;
  const rect = els.mainImage.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  els.cropCanvas.style.width = `${rect.width}px`;
  els.cropCanvas.style.height = `${rect.height}px`;
  els.cropCanvas.width = Math.round(rect.width * dpr);
  els.cropCanvas.height = Math.round(rect.height * dpr);
  drawCropCanvas();
}

function canvasPoint(event) {
  const rect = els.cropCanvas.getBoundingClientRect();
  const scaleX = els.cropCanvas.width / rect.width;
  const scaleY = els.cropCanvas.height / rect.height;
  return {
    x: (event.clientX - rect.left) * scaleX,
    y: (event.clientY - rect.top) * scaleY
  };
}

function cropHit(point) {
  if (!state.crop) return "new";
  const box = normalizeCrop(state.crop);
  const handle = Math.max(12, 10 * (window.devicePixelRatio || 1));
  const nearLeft = Math.abs(point.x - box.x) <= handle;
  const nearRight = Math.abs(point.x - (box.x + box.width)) <= handle;
  const nearTop = Math.abs(point.y - box.y) <= handle;
  const nearBottom = Math.abs(point.y - (box.y + box.height)) <= handle;
  const insideX = point.x >= box.x && point.x <= box.x + box.width;
  const insideY = point.y >= box.y && point.y <= box.y + box.height;

  if (nearLeft && nearTop) return "resize-nw";
  if (nearRight && nearTop) return "resize-ne";
  if (nearLeft && nearBottom) return "resize-sw";
  if (nearRight && nearBottom) return "resize-se";
  if (insideX && insideY) return "move";
  return "new";
}

function clampCrop(crop) {
  const box = normalizeCrop(crop);
  const x = Math.max(0, Math.min(box.x, els.cropCanvas.width - box.width));
  const y = Math.max(0, Math.min(box.y, els.cropCanvas.height - box.height));
  return {
    x,
    y,
    width: Math.min(box.width, els.cropCanvas.width - x),
    height: Math.min(box.height, els.cropCanvas.height - y)
  };
}

function normalizeCrop(crop) {
  const x1 = Math.max(0, Math.min(crop.x, crop.x + crop.width));
  const y1 = Math.max(0, Math.min(crop.y, crop.y + crop.height));
  const x2 = Math.min(els.cropCanvas.width, Math.max(crop.x, crop.x + crop.width));
  const y2 = Math.min(els.cropCanvas.height, Math.max(crop.y, crop.y + crop.height));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

function applyRatio(crop, anchorX, anchorY) {
  const targetRatio = ratioMap[state.ratio];
  if (!targetRatio || crop.width === 0 || crop.height === 0) return crop;
  const signX = crop.width < 0 ? -1 : 1;
  const signY = crop.height < 0 ? -1 : 1;
  let width = Math.abs(crop.width);
  let height = Math.abs(crop.height);
  if (width / height > targetRatio) {
    height = width / targetRatio;
  } else {
    width = height * targetRatio;
  }
  return {
    x: anchorX,
    y: anchorY,
    width: width * signX,
    height: height * signY
  };
}

function drawCropCanvas() {
  const canvas = els.cropCanvas;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(els.mainImage, 0, 0, canvas.width, canvas.height);

  if (!state.crop) return;
  const box = normalizeCrop(state.crop);
  ctx.save();
  ctx.strokeStyle = "#5fd0b5";
  ctx.lineWidth = Math.max(2, window.devicePixelRatio || 1);
  ctx.setLineDash([10, 7]);
  ctx.strokeRect(box.x, box.y, box.width, box.height);
  ctx.setLineDash([]);
  ctx.fillStyle = "#5fd0b5";
  const handle = Math.max(6, 5 * (window.devicePixelRatio || 1));
  for (const [x, y] of [
    [box.x, box.y],
    [box.x + box.width, box.y],
    [box.x, box.y + box.height],
    [box.x + box.width, box.y + box.height]
  ]) {
    ctx.fillRect(x - handle / 2, y - handle / 2, handle, handle);
  }
  ctx.restore();
}

function fullCanvasCrop() {
  return {
    mode: "full",
    x: 0,
    y: 0,
    width: els.mainImage.naturalWidth,
    height: els.mainImage.naturalHeight
  };
}

function cropToNatural() {
  if (!state.crop) return fullCanvasCrop();
  const box = normalizeCrop(state.crop);
  if (box.width < 4 || box.height < 4) return fullCanvasCrop();
  const scaleX = els.mainImage.naturalWidth / els.cropCanvas.width;
  const scaleY = els.mainImage.naturalHeight / els.cropCanvas.height;
  return {
    mode: state.ratio,
    x: Math.round(box.x * scaleX),
    y: Math.round(box.y * scaleY),
    width: Math.round(box.width * scaleX),
    height: Math.round(box.height * scaleY)
  };
}

async function imageDataFromCrop(crop) {
  const output = document.createElement("canvas");
  output.width = crop.width;
  output.height = crop.height;
  const ctx = output.getContext("2d");
  ctx.drawImage(
    els.mainImage,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    crop.width,
    crop.height
  );
  return output.toDataURL("image/png");
}

async function confirmCrop() {
  if (state.busy || state.mode !== "crop") return;
  const file = currentFile();
  if (!file) return;
  state.busy = true;
  try {
    const crop = cropToNatural();
    const imageBase64 = await imageDataFromCrop(crop);
    const payload = await api("/api/classify", {
      method: "POST",
      body: JSON.stringify({
        action: state.pendingAction,
        sourceName: file.name,
        crop,
        imageBase64
      })
    });
    applyPayload(payload);
    toast("已分類並保存裁剪圖");
  } catch (error) {
    toast(error.message);
  } finally {
    state.busy = false;
  }
}

async function classifyDirect(action) {
  if (state.busy || state.mode !== "browse") return;
  const file = currentFile();
  if (!file) return;
  state.busy = true;
  try {
    const payload = await api("/api/classify", {
      method: "POST",
      body: JSON.stringify({ action, sourceName: file.name })
    });
    applyPayload(payload);
    toast("已分類");
  } catch (error) {
    toast(error.message);
  } finally {
    state.busy = false;
  }
}

async function undo() {
  if (state.busy) return;
  state.busy = true;
  try {
    const payload = await api("/api/undo", { method: "POST", body: "{}" });
    applyPayload(payload);
    toast("已復原");
  } catch (error) {
    toast(error.message);
  } finally {
    state.busy = false;
  }
}

async function pause() {
  if (state.busy) return;
  state.busy = true;
  try {
    const payload = await api("/api/pause", { method: "POST", body: "{}" });
    applyPayload(payload);
    showSummary("暫停", "Session 已保存");
  } catch (error) {
    toast(error.message);
  } finally {
    state.busy = false;
  }
}

async function startGroup() {
  if (state.busy || state.mode !== "browse") return;
  state.busy = true;
  try {
    const payload = await api("/api/group/start", { method: "POST", body: "{}" });
    applyPayload(payload);
    toast("已開始文字 group");
  } catch (error) {
    toast(error.message);
  } finally {
    state.busy = false;
  }
}

async function endGroup() {
  if (state.busy || state.mode !== "browse") return;
  state.busy = true;
  try {
    const payload = await api("/api/group/end", { method: "POST", body: "{}" });
    applyPayload(payload);
    toast("已結束文字 group");
  } catch (error) {
    toast(error.message);
  } finally {
    state.busy = false;
  }
}

async function cancelGroup() {
  if (state.busy || state.mode !== "browse") return;
  state.busy = true;
  try {
    const payload = await api("/api/group/cancel", { method: "POST", body: "{}" });
    applyPayload(payload);
    toast("已取消目前 group，截圖已復原");
  } catch (error) {
    toast(error.message);
  } finally {
    state.busy = false;
  }
}

function toggleGroup() {
  if (state.session?.activeGroup) {
    endGroup();
  } else {
    startGroup();
  }
}

els.cropCanvas.addEventListener("pointerdown", (event) => {
  if (state.mode !== "crop") return;
  const point = canvasPoint(event);
  const hit = cropHit(point);
  const box = state.crop ? normalizeCrop(state.crop) : null;
  state.drag = {
    startX: point.x,
    startY: point.y,
    hit,
    original: box
  };
  if (hit === "new") {
    state.crop = { x: point.x, y: point.y, width: 0, height: 0 };
  }
  els.cropCanvas.setPointerCapture(event.pointerId);
  drawCropCanvas();
});

els.cropCanvas.addEventListener("pointermove", (event) => {
  if (state.mode !== "crop" || !state.drag) return;
  const point = canvasPoint(event);
  const dx = point.x - state.drag.startX;
  const dy = point.y - state.drag.startY;
  const original = state.drag.original;

  if (state.drag.hit === "move" && original) {
    state.crop = clampCrop({ ...original, x: original.x + dx, y: original.y + dy });
  } else if (state.drag.hit.startsWith("resize") && original) {
    let x = original.x;
    let y = original.y;
    let width = original.width;
    let height = original.height;
    if (state.drag.hit.includes("w")) {
      x = original.x + dx;
      width = original.width - dx;
    }
    if (state.drag.hit.includes("e")) {
      width = original.width + dx;
    }
    if (state.drag.hit.includes("n")) {
      y = original.y + dy;
      height = original.height - dy;
    }
    if (state.drag.hit.includes("s")) {
      height = original.height + dy;
    }
    state.crop = normalizeCrop(applyRatio({ x, y, width, height }, x, y));
  } else {
    const raw = {
      x: state.drag.startX,
      y: state.drag.startY,
      width: point.x - state.drag.startX,
      height: point.y - state.drag.startY
    };
    state.crop = applyRatio(raw, state.drag.startX, state.drag.startY);
  }
  drawCropCanvas();
});

els.cropCanvas.addEventListener("pointerup", () => {
  state.drag = null;
  if (state.crop) state.crop = normalizeCrop(state.crop);
  drawCropCanvas();
});

els.mainImage.addEventListener("pointerdown", (event) => {
  if (state.mode !== "browse" || state.zoom <= 1) return;
  state.panDrag = {
    startX: event.clientX,
    startY: event.clientY,
    panX: state.panX,
    panY: state.panY
  };
  els.mainImage.classList.add("dragging");
  els.mainImage.setPointerCapture(event.pointerId);
});

els.mainImage.addEventListener("pointermove", (event) => {
  if (!state.panDrag) return;
  state.panX = state.panDrag.panX + event.clientX - state.panDrag.startX;
  state.panY = state.panDrag.panY + event.clientY - state.panDrag.startY;
  clampPan();
  applyImageTransform();
});

function stopPan() {
  state.panDrag = null;
  els.mainImage.classList.remove("dragging");
}

els.mainImage.addEventListener("pointerup", stopPan);
els.mainImage.addEventListener("pointercancel", stopPan);

els.viewer.addEventListener("wheel", (event) => {
  if (state.mode !== "browse" || !currentFile()) return;
  event.preventDefault();
  if (isPointerOnImage(event)) {
    zoomBy(event.deltaY < 0 ? 1 : -1);
    return;
  }
  moveIndex(event.deltaY > 0 ? 1 : -1);
}, { passive: false });

els.cropTools.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-ratio]");
  if (button) setRatio(button.dataset.ratio);
});

els.resumeButton.addEventListener("click", () => {
  if (state.session?.complete) return;
  if (state.session) state.session.paused = false;
  hideSummary();
  render();
});

window.addEventListener("resize", () => {
  if (state.mode === "crop") setupCropCanvas();
  clampPan();
  applyImageTransform();
});

document.addEventListener("keydown", (event) => {
  if (state.busy) return;
  const key = event.key.toLowerCase();
  const repeatable = ["arrowleft", "arrowright", "arrowup", "arrowdown", "a", "d"].includes(key);
  if (event.repeat && !repeatable) return;

  if (!els.summaryPanel.hidden && key !== "p") {
    if (key === "escape" || key === "enter" || key === " ") {
      event.preventDefault();
      els.resumeButton.click();
    }
    return;
  }

  if (state.mode === "crop") {
    if (event.key === "Enter" || key === " ") {
      event.preventDefault();
      confirmCrop();
    }
    if (event.key === "Escape") {
      exitCropMode();
      render();
    }
    if (["1", "2", "3", "4"].includes(event.key)) {
      setRatio({ 1: "free", 2: "1:1", 3: "3:4", 4: "16:9" }[event.key]);
    }
    return;
  }

  if (["arrowleft", "arrowright", "arrowup", "arrowdown", " "].includes(key)) {
    event.preventDefault();
  }
  if (key === "q") enterCropMode("extract-text");
  if (key === "w") enterCropMode("keep");
  if (key === "e") classifyDirect("review-later");
  if (key === "r") classifyDirect("trash-candidate");
  if (key === "z") undo();
  if (key === "p") pause();
  if (key === "g" && event.shiftKey) cancelGroup();
  if (key === "g" && !event.shiftKey) toggleGroup();
  if (key === "arrowleft" || key === "a") moveIndex(-1);
  if (key === "arrowright" || key === "d") moveIndex(1);
  if (key === "arrowup") zoomBy(1);
  if (key === "arrowdown") zoomBy(-1);
});

loadSession().catch((error) => {
  toast(error.message);
  els.fileName.textContent = "載入失敗";
});
