// 텔레그램 미니앱: 단체방 버튼으로 여는 활동 시간 입력 창 (GET /app = 화면, POST /app-api = 불러오기·저장)
import http from 'http';
import { createHmac, timingSafeEqual } from 'crypto';
import { Telegraf } from 'telegraf';
import { appApi } from './bot';

// 텔레그램이 서명한 initData 확인 (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
export function verifyInitData(initData: string, botToken: string, maxAgeSec = 24 * 3600) {
    const p = new URLSearchParams(initData);
    const hash = Buffer.from(p.get('hash') || '', 'hex');
    p.delete('hash');
    const check = [...p.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${k}=${v}`)
        .join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
    const calc = createHmac('sha256', secret).update(check).digest();
    if (hash.length !== calc.length || !timingSafeEqual(hash, calc)) return null;
    if (Date.now() / 1000 - Number(p.get('auth_date')) > maxAgeSec) return null;
    try {
        const user = JSON.parse(p.get('user') || '');
        return typeof user?.id === 'number' ? { user, startParam: p.get('start_param') || '' } : null;
    } catch {
        return null;
    }
}

const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
};

function readBody(req: http.IncomingMessage, limit = 32 * 1024): Promise<string> {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (c) => {
            data += c;
            if (data.length > limit) reject(new Error('too large'));
        });
        req.on('end', () => resolve(data));
        req.on('error', reject);
    });
}

// 처리했으면 true
export async function handleWebApp(req: http.IncomingMessage, res: http.ServerResponse, route: string, telegram: Telegraf['telegram'], botToken: string) {
    if (req.method === 'GET' && route === '/app') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(PAGE);
        return true;
    }
    if (req.method !== 'POST' || route !== '/app-api') return false;
    try {
        const body = JSON.parse(await readBody(req));
        const v = verifyInitData(String(body.initData || ''), botToken);
        if (!v) return json(res, 401, { error: '텔레그램 단체방의 버튼으로 다시 열어주세요.' }), true;
        const text = typeof body.text === 'string' ? body.text.slice(0, 2000) : undefined;
        json(res, 200, await appApi(telegram, v.user, v.startParam, text));
    } catch (err) {
        console.error('[미니앱 처리 에러]:', err);
        json(res, 500, { error: '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' });
    }
    return true;
}

const PAGE = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>활동 시간 입력</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
  body { margin: 0; padding: 16px; font: 16px/1.5 -apple-system, system-ui, sans-serif;
         background: var(--tg-theme-bg-color, #fff); color: var(--tg-theme-text-color, #222); }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .hint { color: var(--tg-theme-hint-color, #888); font-size: 14px; margin: 4px 0 12px; }
  textarea { box-sizing: border-box; width: 100%; height: 200px; padding: 10px; font: inherit; font-family: ui-monospace, monospace;
             border: 1px solid var(--tg-theme-hint-color, #ccc); border-radius: 8px;
             background: var(--tg-theme-secondary-bg-color, #f6f6f6); color: inherit; }
  button { width: 100%; margin-top: 12px; padding: 12px; font: inherit; font-weight: 600; border: 0; border-radius: 8px;
           background: var(--tg-theme-button-color, #2481cc); color: var(--tg-theme-button-text-color, #fff); }
  button:disabled { opacity: .5; }
  #msg { white-space: pre-wrap; margin-top: 12px; }
  .err { color: #d33; }
</style></head>
<body>
<h1>📝 활동 가능 시간</h1>
<div id="week" class="hint">불러오는 중…</div>
<textarea id="t" placeholder="월/12-14,18-20&#10;화/15-18,19-21&#10;수/불가&#10;목/11-19&#10;금/11-20&#10;토/10-20" disabled></textarea>
<div class="hint">한 줄에 한 요일 · 시간이 여러 개면 쉼표 · 활동 못 하는 날은 <b>불가</b><br>안 적은 요일은 활동 불가로 저장됩니다.</div>
<button id="b" disabled>제출</button>
<div id="msg"></div>
<script>
  const tg = window.Telegram.WebApp;
  tg.ready(); tg.expand();
  const $ = (id) => document.getElementById(id);
  const show = (html, err) => { $('msg').className = err ? 'err' : ''; $('msg').innerHTML = html; };
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  async function api(text) {
    const r = await fetch('app-api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData: tg.initData, text }) });
    return r.json();
  }
  api().then((r) => {
    if (r.error) { $('week').textContent = ''; return show(esc(r.error), true); }
    $('week').textContent = r.week + ' 주차 · ' + r.name + (r.text ? ' · 이미 제출한 내용을 불러왔습니다' : '');
    $('t').value = r.text; $('t').disabled = false; $('b').disabled = false;
  }).catch(() => show('연결에 실패했습니다. 다시 열어주세요.', true));
  $('b').onclick = async () => {
    $('b').disabled = true;
    try {
      const r = await api($('t').value);
      if (r.error) show('⚠️ ' + esc(r.error), true);
      else { show('✅ <b>' + r.done + ' 완료</b> (' + r.week + ')<br><br>' + r.html.replace(/\\n/g, '<br>')); tg.HapticFeedback && tg.HapticFeedback.notificationOccurred('success'); $('b').textContent = '다시 제출'; }
    } catch (e) { show('연결에 실패했습니다. 다시 시도해주세요.', true); }
    $('b').disabled = false;
  };
</script>
</body></html>`;
