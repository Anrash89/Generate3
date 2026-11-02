/* Label export v1.0.0. No server and no CDN. The DOM supplies the layout;
 * PDF-lib writes real text, vector barcode bars and the original icon images. */
(() => {
  'use strict';
  const assetBase = new URL('.', document.currentScript.src);
  const PT_PER_PX = 72 / 96;
  const PT_PER_MM = 72 / 25.4;
  const cache = new Map();
  let busy = false;
  let printRoot = null;
  let printStyle = null;

  const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
  async function bytes(path) {
    const url = new URL(path, assetBase).href;
    if (!cache.has(url)) cache.set(url, fetch(url).then(response => {
      if (!response.ok) throw new Error('Не удалось загрузить ресурс экспорта');
      return response.arrayBuffer();
    }).catch(error => { cache.delete(url); throw error; }));
    return cache.get(url);
  }
  async function loadScript(path, globalName) {
    if (window[globalName]) return;
    const key = 'script:' + path;
    if (!cache.has(key)) cache.set(key, new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = new URL(path, assetBase).href;
      script.onload = resolve;
      script.onerror = () => { cache.delete(key); script.remove(); reject(new Error('Не удалось загрузить модуль PDF')); };
      document.head.appendChild(script);
    }));
    await cache.get(key);
  }
  async function ready(sheet) {
    if (!sheet) throw new Error('Этикетка ещё не готова');
    await Promise.all([
      document.fonts.load('12px LabelSans'), document.fonts.load('bold 12px LabelSans'),
      document.fonts.load('12px LabelMono'),
      ...Array.from(sheet.querySelectorAll('img'), image => image.decode())
    ]);
    await document.fonts.ready;
    await nextFrame();
    await nextFrame();
  }
  function validate(data, sheet) {
    if (![data.labelWidth, data.labelHeight].every(n => Number.isFinite(n) && n >= 20 && n <= 500)) {
      throw new Error('Размер этикетки должен быть от 20 до 500 мм');
    }
    const parts = ['.label-main', '.label-details', '.label-icons'];
    if (parts.some(selector => {
      const el = sheet.querySelector(selector);
      return el && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
    })) throw new Error('Текст или знаки не помещаются. Увеличьте этикетку или уменьшите шрифт / знаки.');
    if (data.ean13.trim() && !sheet.querySelector('.label-barcode svg rect')) {
      throw new Error('Не удалось построить штрихкод. Проверьте введённое значение.');
    }
  }
  async function snapshot(sheet, data) {
    await ready(sheet);
    const stage = document.createElement('div');
    stage.className = 'label-export-stage';
    stage.setAttribute('aria-hidden', 'true');
    const clone = sheet.cloneNode(true);
    clone.querySelectorAll('.safe-area').forEach(el => el.remove());
    stage.appendChild(clone);
    document.body.appendChild(stage);
    try {
      await ready(clone);
      validate(data, clone);
      return { sheet: clone, stage };
    } catch (error) { stage.remove(); throw error; }
  }
  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  function filename(data, extension) {
    return 'etiketka-' + (data.sku || 'bez-artikula').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') + '.' + extension;
  }
  async function fontsFor(doc) {
    doc.registerFontkit(window.fontkit);
    const [regular, bold, mono] = await Promise.all([
      bytes('fonts/LiberationSans-Regular.ttf'), bytes('fonts/LiberationSans-Bold.ttf'),
      bytes('fonts/DejaVuSansMono.ttf')
    ]);
    return {
      regular: await doc.embedFont(regular, { subset: true }),
      bold: await doc.embedFont(bold, { subset: true }),
      mono: await doc.embedFont(mono, { subset: true })
    };
  }
  function drawDOMText(page, sheet, fonts, origin, pageHeight) {
    const walker = document.createTreeWalker(sheet.querySelector('.label-main'), NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    const canvas = document.createElement('canvas').getContext('2d');
    let node;
    let activeFont;
    while ((node = walker.nextNode())) {
      const style = getComputedStyle(node.parentElement);
      const font = Number(style.fontWeight) >= 600 ? fonts.bold : fonts.regular;
      if (activeFont !== font) { page.setFont(font); activeFont = font; }
      const fontSize = parseFloat(style.fontSize);
      canvas.font = `${style.fontWeight} ${style.fontSize} LabelSans`;
      const metrics = canvas.measureText('HgБ');
      // Range boxes contain the font's ascent + descent, not CSS line-height.
      const ascent = metrics.fontBoundingBoxAscent;
      const descent = metrics.fontBoundingBoxDescent;
      let start = 0;
      for (const char of node.textContent) {
        const end = start + char.length;
        range.setStart(node, start);
        range.setEnd(node, end);
        const box = range.getBoundingClientRect();
        if (box.width > 0 && char !== '\n' && char !== '\r') {
          const baseline = box.top + (box.height - ascent - descent) / 2 + ascent;
          page.drawText(char, {
            x: (box.left - origin.left) * PT_PER_PX,
            y: pageHeight - (baseline - origin.top) * PT_PER_PX,
            size: fontSize * PT_PER_PX,
            color: window.PDFLib.rgb(0, 0, 0)
          });
        }
        start = end;
      }
    }
  }
  function drawBarcode(page, sheet, font, origin, pageHeight) {
    const svg = sheet.querySelector('.label-barcode svg');
    if (!svg) return;
    page.setFont(font);
    const point = (matrix, x, y) => ({
      x: (matrix.a * x + matrix.c * y + matrix.e - origin.left) * PT_PER_PX,
      y: pageHeight - (matrix.b * x + matrix.d * y + matrix.f - origin.top) * PT_PER_PX
    });
    for (const element of svg.querySelectorAll('rect, text')) {
      const matrix = element.getScreenCTM();
      if (!matrix) continue;
      if (element.tagName.toLowerCase() === 'rect') {
        const box = element.getBBox();
        const p = point(matrix, box.x, box.y);
        const q = point(matrix, box.x + box.width, box.y + box.height);
        const fill = getComputedStyle(element).fill;
        if (fill === 'none') continue;
        const isWhite = fill === 'rgb(255, 255, 255)' || fill === '#ffffff';
        page.drawRectangle({
          x: Math.min(p.x, q.x), y: Math.min(p.y, q.y),
          width: Math.abs(q.x - p.x), height: Math.abs(q.y - p.y),
          color: window.PDFLib.rgb(isWhite ? 1 : 0, isWhite ? 1 : 0, isWhite ? 1 : 0)
        });
      } else {
        const size = parseFloat(getComputedStyle(element).fontSize) * Math.hypot(matrix.a, matrix.b) * PT_PER_PX;
        for (let i = 0; i < element.textContent.length; i++) {
          const pos = element.getStartPositionOfChar(i);
          const p = point(matrix, pos.x, pos.y);
          page.drawText(element.textContent[i], {
            x: p.x, y: p.y, size,
            rotate: window.PDFLib.degrees(-Math.atan2(matrix.b, matrix.a) * 180 / Math.PI),
            color: window.PDFLib.rgb(0, 0, 0)
          });
        }
      }
    }
  }
  async function drawIcons(doc, page, sheet, origin, pageHeight) {
    for (const img of sheet.querySelectorAll('.label-icons img')) {
      const box = img.getBoundingClientRect();
      const x = (box.left - origin.left) * PT_PER_PX;
      const y = pageHeight - (box.bottom - origin.top) * PT_PER_PX;
      const width = box.width * PT_PER_PX, height = box.height * PT_PER_PX;
      if (new URL(img.src).pathname.endsWith('/class-ii.svg')) {
        // The supplied SVG is two squares. Keep this marking vector too.
        const unit = Math.min(width, height) / 100;
        for (const [inset, side] of [[8.5, 83], [30.5, 39]]) page.drawRectangle({
          x: x + inset * unit, y: y + inset * unit,
          width: side * unit, height: side * unit,
          borderWidth: 7 * unit, borderColor: window.PDFLib.rgb(0, 0, 0)
        });
      } else {
        const image = await doc.embedPng(await bytes(img.src));
        page.drawImage(image, { x, y, width, height });
      }
    }
  }
  async function makePDF({ sheet, data }) {
    const snap = await snapshot(sheet, data);
    try {
      await Promise.all([loadScript('vendor/pdf-lib.min.js', 'PDFLib'), loadScript('vendor/fontkit.umd.min.js', 'fontkit')]);
      const pdf = await window.PDFLib.PDFDocument.create();
      pdf.setTitle(data.productName || 'Этикетка');
      pdf.setCreator('Конструктор этикеток / векторный экспорт');
      const width = data.labelWidth * PT_PER_MM, height = data.labelHeight * PT_PER_MM;
      const page = pdf.addPage([width, height]);
      const fonts = await fontsFor(pdf);
      const origin = snap.sheet.getBoundingClientRect();
      const border = parseFloat(getComputedStyle(snap.sheet).borderTopWidth) * PT_PER_PX;
      page.drawRectangle({ x: border / 2, y: border / 2, width: width - border, height: height - border,
        borderWidth: border, borderColor: window.PDFLib.rgb(0, 0, 0) });
      drawDOMText(page, snap.sheet, fonts, origin, height);
      drawBarcode(page, snap.sheet, fonts.mono, origin, height);
      await drawIcons(pdf, page, snap.sheet, origin, height);
      return await pdf.save();
    } finally { snap.stage.remove(); }
  }
  async function downloadPDF(options) {
    if (busy) return;
    busy = true;
    try {
      const content = await makePDF(options);
      download(new Blob([content], { type: 'application/pdf' }), filename(options.data, 'pdf'));
      options.notify?.('PDF готов: точный размер, векторные текст и штрихкод');
    } catch (error) {
      console.error('PDF export:', error);
      options.notify?.(error.message || 'Не удалось подготовить PDF');
    } finally { busy = false; }
  }
  function pngAt600DPI(url) {
    const source = Uint8Array.from(atob(url.split(',')[1]), char => char.charCodeAt(0));
    const view = new DataView(source.buffer);
    // Store actual resolution, so layout programs import the PNG at its mm size.
    const chunk = new Uint8Array(21), out = new DataView(chunk.buffer);
    out.setUint32(0, 9);
    chunk.set([112, 72, 89, 115], 4); // pHYs
    out.setUint32(8, Math.round(600 / 0.0254));
    out.setUint32(12, Math.round(600 / 0.0254));
    chunk[16] = 1;
    let crc = 0xffffffff;
    for (const byte of chunk.subarray(4, 17)) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    out.setUint32(17, (crc ^ 0xffffffff) >>> 0);
    const parts = [source.subarray(0, 8)];
    for (let pos = 8; pos < source.length;) {
      const length = view.getUint32(pos) + 12;
      const type = String.fromCharCode(...source.subarray(pos + 4, pos + 8));
      if (type !== 'pHYs') parts.push(source.subarray(pos, pos + length));
      if (type === 'IHDR') parts.push(chunk);
      pos += length;
    }
    return new Blob(parts, { type: 'image/png' });
  }
  async function downloadPNG(options) {
    if (busy) return;
    busy = true;
    let snap;
    try {
      snap = await snapshot(options.sheet, options.data);
      const url = await options.render(snap.sheet, {
        pixelRatio: 600 / 96, cacheBust: true, backgroundColor: '#ffffff'
      });
      download(pngAt600DPI(url), filename(options.data, 'png'));
      options.notify?.('PNG готов: 600 DPI');
    } catch (error) { console.error('PNG export:', error); options.notify?.(error.message || 'Не удалось подготовить PNG'); }
    finally { snap?.stage.remove(); busy = false; }
  }
  function cleanupPrint() {
    printRoot?.remove(); printRoot = null;
    printStyle?.remove(); printStyle = null;
    document.body.classList.remove('label-isolated-print');
  }
  function pageStyle(sheet) {
    const style = document.createElement('style');
    style.textContent = `@page { size: ${sheet.style.width} ${sheet.style.height}; margin: 0; }`;
    return style;
  }
  async function print(options) {
    if (busy) return;
    busy = true;
    let snap;
    try {
      snap = await snapshot(options.sheet, options.data);
      cleanupPrint();
      printRoot = document.createElement('div');
      printRoot.className = 'label-print-root';
      printRoot.appendChild(snap.sheet);
      printStyle = pageStyle(snap.sheet);
      document.head.appendChild(printStyle);
      document.body.appendChild(printRoot);
      document.body.classList.add('label-isolated-print');
      await nextFrame();
      window.print();
      // afterprint owns cleanup. A timer can fire before a non-blocking dialog closes.
    } catch (error) { cleanupPrint(); options.notify?.(error.message); }
    finally { snap?.stage.remove(); busy = false; }
  }
  window.addEventListener('afterprint', cleanupPrint);
  window.addEventListener('beforeprint', () => {
    if (!printStyle) {
      const sheet = document.querySelector('.preview-surface .label-sheet');
      if (sheet) { printStyle = pageStyle(sheet); document.head.appendChild(printStyle); }
    }
  });
  window.LabelExport = { ready, makePDF, downloadPDF, downloadPNG, print, validate };
})();
