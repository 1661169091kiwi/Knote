// One-off README screenshot rig: loads the dev server in a fresh Electron
// window (isolated userData => pristine app state), stages three scenes via
// executeJavaScript, and saves PNGs to docs/screenshots/.
// Usage: npx electron scripts/readme-shots.cjs [devServerUrl]
const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')

const URL = process.argv[2] || 'http://localhost:5173'
const OUT = path.join(__dirname, '..', 'docs', 'screenshots')
app.setPath('userData', path.join(app.getPath('temp'), 'knote-readme-shots'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function shoot(win, name) {
  const img = await win.webContents.capturePage()
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, name), img.toPNG())
  console.log('saved', name)
}

const STAGE_COMMON = `
  window.__sleep = (ms) => new Promise(r => setTimeout(r, ms));
  window.__assemblePdf = () => {
    const objs = [];
    objs[1] = '1 0 obj\\n<< /Type /Catalog /Pages 2 0 R >>\\nendobj\\n';
    objs[2] = '2 0 obj\\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\\nendobj\\n';
    objs[3] = '3 0 obj\\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\\nendobj\\n';
    const body = 'BT /F1 12 Tf 72 700 Td (Machine learning survey chapter one content.) Tj ET';
    objs[4] = '4 0 obj\\n<< /Length ' + body.length + ' >>\\nstream\\n' + body + '\\nendstream\\nendobj\\n';
    objs[5] = '5 0 obj\\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\\nendobj\\n';
    let pdf = '%PDF-1.4\\n';
    const offsets = [0];
    for (let i = 1; i <= 5; i++) { offsets[i] = pdf.length; pdf += objs[i]; }
    const xrefPos = pdf.length;
    pdf += 'xref\\n0 6\\n0000000000 65535 f \\n';
    for (let i = 1; i <= 5; i++) pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \\n';
    pdf += 'trailer\\n<< /Size 6 /Root 1 0 R >>\\nstartxref\\n' + xrefPos + '\\n%%EOF';
    return new Uint8Array([...pdf].map(c => c.charCodeAt(0)));
  };
  true;
`

// scene 2: a real agent run against a mocked provider — leaves a red/green
// review diff in the document and a reply bubble in the open panel
const STAGE_DIFF = `
  (async () => {
    const sleep = window.__sleep;
    localStorage.setItem('knote-agent-config', JSON.stringify({
      config: { protocol: 'openai', baseUrl: 'https://mock.local/v1', apiKey: 'sk-demo', model: 'deepseek-chat', jinaKey: '', systemExtra: '', verify: false, reasoning: '', ctxWindow: 128000, ctxWinUser: true },
      capabilities: { checked: true, checking: false, chat: true, vision: true, tools: true, pdf: false, error: '', notes: {} }
    }));
    location.reload();
  })()
`

const STAGE_DIFF2 = `
  (async () => {
    const sleep = window.__sleep;
    await sleep(1200);
    const sse = (events) => new Response(new ReadableStream({
      start(c) { const enc = new TextEncoder(); for (const e of events) c.enqueue(enc.encode('data: ' + JSON.stringify(e) + '\\n\\n')); c.enqueue(enc.encode('data: [DONE]\\n\\n')); c.close(); }
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const chunk = (delta, finish = null) => ({ choices: [{ delta, finish_reason: finish }] });
    const toolCall = (name, args) => sse([
      chunk({ tool_calls: [{ index: 0, id: 'tc-' + name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }),
      chunk({}, 'tool_calls')
    ]);
    let call = 0;
    const origFetch = window.fetch;
    window.fetch = async (url, opts) => {
      if (String(url).includes('mock.local')) {
        call++;
        if (call === 1) return toolCall('read_document', {});
        if (call === 2) return toolCall('replace_lines', { start_line: 9, end_line: 9, content: '语法：**粗体**、*斜体*、~~删除线~~、==高亮==、++下划线++、反引号包裹 \`行内代码\`；组合使用也没问题，比如 **==加粗高亮==**。' });
        return sse([chunk({ content: '我把「文字样式」一节的语法说明补充了组合用法的示例，改动已按红绿 diff 暂存在文档里——绿色是建议的新内容，红色是被替换的原文。你可以逐块接受，也可以点底部的「全部接受」。' }), chunk({}, 'stop')]);
      }
      return origFetch(url, opts);
    };
    const dock = document.querySelector('.knote-agent-dock');
    if (dock.children[0].getBoundingClientRect().height === 0) { (dock.querySelector('.knote-mascot button') || dock.querySelector('.knote-mascot')).click(); await sleep(500); }
    const panel = dock.children[0];
    const ta = panel.querySelector('textarea');
    ta.value = '帮我把「文字样式」一节的语法说明写得更全一点';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(150);
    [...panel.querySelectorAll('button')].reverse().find(b => !b.disabled && b.closest('.px-3.pt-2')).click();
    for (let i = 0; i < 60; i++) { await sleep(200); if (document.querySelector('.knote-agent-new-body')) break; }
    await sleep(600);
    // bring the diff into view
    const w = document.querySelector('.knote-agent-new-body');
    if (w) w.scrollIntoView({ block: 'center' });
    await sleep(400);
    return !!w;
  })()
`

// scene 3: PDF chip + digest-style reply with an inline figure — pure UI
// flow (attach via the real input, reply via mocked fetch), so it renders in
// the same panel regardless of module-instance games
const STAGE_CHAT = `
  (async () => {
    const sleep = window.__sleep;
    // a small synthetic "figure" image the mocked reply embeds as a data URL
    const cv = document.createElement('canvas'); cv.width = 420; cv.height = 240;
    const g = cv.getContext('2d');
    g.fillStyle = '#f8faf2'; g.fillRect(0, 0, 420, 240);
    g.strokeStyle = '#d4dcc0'; g.lineWidth = 1;
    for (let y = 40; y < 220; y += 36) { g.beginPath(); g.moveTo(44, y); g.lineTo(400, y); g.stroke(); }
    g.strokeStyle = '#4d7c0f'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(44, 20); g.lineTo(44, 208); g.lineTo(400, 208); g.stroke();
    g.strokeStyle = '#84cc16'; g.lineWidth = 4; g.beginPath(); g.moveTo(48, 40);
    for (let x = 0; x <= 340; x += 10) g.lineTo(48 + x, 40 + 160 * (1 - Math.exp(-x / 110)));
    g.stroke();
    g.fillStyle = '#365314'; g.font = 'bold 15px sans-serif'; g.fillText('Figure 2: training loss', 52, 232);
    const figUrl = cv.toDataURL('image/png');
    // sidecar mock so the attached PDF structures instantly (chip shows ✓)
    window.knoteDesktop = {
      pdfAnalyze: async () => ({ ok: true, mode: 'layout', width: 1224, height: 1584, elements: [
        { id: 'e1', type: 'figure', bbox: [0.1, 0.3, 0.9, 0.6], score: 0.9, text: '' }
      ]})
    };
    let call = 0;
    const sse = (events) => new Response(new ReadableStream({
      start(c) { const enc = new TextEncoder(); for (const e of events) c.enqueue(enc.encode('data: ' + JSON.stringify(e) + '\\n\\n')); c.enqueue(enc.encode('data: [DONE]\\n\\n')); c.close(); }
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const chunk = (delta, finish = null) => ({ choices: [{ delta, finish_reason: finish }] });
    const origFetch = window.fetch;
    window.fetch = async (url, opts) => {
      if (String(url).includes('mock.local')) {
        call++;
        if (call === 1) return sse([
          chunk({ content: '已读取讲义的结构化摘要——第 7 页的 Figure 2 是训练损失随轮数变化的曲线：前期下降快（学习率大、梯度方向明确），后期趋于平缓（接近收敛）。\\n\\n![Figure 2: training loss](' + figUrl + ')\\n\\n我已把这张图连同解释插入「训练技巧」一节，改动以红绿 diff 暂存在文档里等你审核。' }),
          chunk({}, 'stop')
        ]);
        return sse([chunk({ content: '讲义配图' }), chunk({}, 'stop')]);
      }
      return origFetch(url, opts);
    };
    // drive the VISIBLE (sidebar) panel; start a fresh session for a clean shot
    const tas = [...document.querySelectorAll('textarea.knote-agent-input')].filter(t => t.getBoundingClientRect().height > 0);
    const ta = tas[0];
    const host = ta.closest('.relative.flex.flex-col');
    const plus = host.querySelector('button svg path[d^="M12 4.5v15"]');
    if (plus) { plus.closest('button').click(); await sleep(400); }
    // attach the demo PDF through the real picker input
    const input = host.querySelector('input[type="file"]');
    const dt = new DataTransfer();
    dt.items.add(new File([window.__assemblePdf()], '机器学习讲义.pdf', { type: 'application/pdf' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(1500); // structuring (1 page, mocked) completes -> chip ✓
    ta.value = '把讲义第 7 页的损失曲线图配到「训练技巧」一节，并简单解释一下';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(150);
    [...host.querySelectorAll('button')].reverse().find(b => !b.disabled && b.closest('.px-3.pt-2')).click();
    for (let i = 0; i < 40; i++) { await sleep(200); if (host.innerText.includes('训练技巧')) break; }
    await sleep(500);
    // bring the reply into view (retry — a late render can reset the scroll)
    for (let i = 0; i < 3; i++) {
      const list = [...host.querySelectorAll('.overflow-y-auto')].find(el => el.querySelector('.knote-agent-md'));
      if (list) list.scrollTop = list.scrollHeight;
      await sleep(300);
    }
    const img = [...host.querySelectorAll('.knote-agent-md img')].some(i => i.getBoundingClientRect().height > 0);
    const r = host.getBoundingClientRect();
    return JSON.stringify({ replied: host.innerText.includes('训练技巧'), imgShown: img,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } });
  })()
`

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { contextIsolation: true } })
  await win.loadURL(URL)
  await sleep(1500)
  await win.webContents.executeJavaScript(STAGE_COMMON)

  // scene 1: hero editor (pristine state — fresh userData means no leftovers)
  await shoot(win, 'editor.png')

  // scene 2: diff review
  await win.webContents.executeJavaScript(STAGE_DIFF)
  await sleep(1800)
  await win.webContents.executeJavaScript(STAGE_COMMON)
  const ok = await win.webContents.executeJavaScript(STAGE_DIFF2)
  console.log('diff staged:', ok)
  await sleep(500)
  await shoot(win, 'agent-diff.png')

  // scene 3: chat with PDF + inline image — crop to the chat panel itself
  const diag = await win.webContents.executeJavaScript(STAGE_CHAT)
  console.log('chat staged:', diag)
  await sleep(600)
  const rect = JSON.parse(diag).rect
  const img3 = await win.webContents.capturePage({ x: rect.x, y: rect.y, width: rect.w, height: rect.h })
  fs.writeFileSync(path.join(OUT, 'agent-chat.png'), img3.toPNG())
  console.log('saved agent-chat.png (cropped)')

  app.quit()
}).catch((e) => { console.error(e); app.exit(1) })
