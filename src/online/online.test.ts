// 온라인 방: 인스타 중복 알림·하루 현황, '#항목 #지역' 취합. 실행: npm test
import { pgliteQueryable } from '../test-setup';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { Telegraf, Telegram } from 'telegraf';
import { runMigrations, setQueryable } from '../db';
import { registerCore } from '../core/engine';
import { registerSida } from '../sida/bot';
import { handleRelay, parseInstaIds, parseTally, publishRelay, registerOnline, relaySecretOk, sendDailyInstaReports } from './bot';
import { query } from '../db';

const ADMIN = 9000;
const DUP = -100111;
const TALLY = -100222;
const POST = 'emstiy/김지연/20대초중반/성북구 거주예상/국민대학생,자취,본가는 춘천,영문학과\n\nhttps://www.instagram.com/emstiy?dlrf=ZHJqN2NxaDF0YmUx';

test('파싱', () => {
    assert.deepEqual(parseInstaIds(POST), ['emstiy']);
    assert.deepEqual(parseInstaIds('https://instagram.com/p/abc123 그리고 10/8/오후 약속'), []);
    assert.deepEqual(parseInstaIds('Kim.Ji_99/박하나/20대'), ['kim.ji_99']);
    assert.deepEqual(parseTally('#출석 #도봉 12명\n결석 2'), { topic: '출석', region: '도봉', content: '12명 결석 2' });
    assert.deepEqual(parseTally('#성북구 #출석 9명 #메모'), { topic: '출석', region: '성북', content: '9명 #메모' });
    assert.equal(parseTally('#출석 #부산'), null);
    assert.equal(parseTally('#도봉 12명'), null);
});

let calls: { method: string; payload: any; token: string }[] = [];
(Telegram.prototype as any).callApi = async function (this: any, method: string, payload: any) {
    calls.push({ method, payload, token: this.token });
    return { message_id: calls.length, date: 0, chat: { id: payload.chat_id, type: 'supergroup' }, text: payload.text };
};
const bot = new Telegraf('1:TEST');
bot.botInfo = { id: 1, is_bot: true, first_name: 'sida', username: 'sidabot' } as any;
registerCore(bot);
registerOnline(bot);
registerSida(bot); // 특전대가 '아이디/이름/…' 줄을 가로채지 않는지
let n = 0;
// relay: 카운셀링 봇이 /relay 로 넘긴 것처럼 — 텔레그램으로 직접 보내지 않고 보낼 답 목록을 돌려받음
async function send(from: number, text: string, chatId: number, relay = false) {
    calls = [];
    const update = {
        update_id: ++n,
        message: { message_id: 5000 + n, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'supergroup' }, from: { id: from, is_bot: false, first_name: `U${from}` }, text },
    } as any;
    if (relay) {
        const actions = await handleRelay(update);
        assert.equal(calls.length, 0); // 시다봇이 직접 보낸 것 없음
        calls = actions.map((a) => ({ ...a, token: 'relay' }));
    } else await bot.handleUpdate(update);
    return calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text).join('\n---\n');
}
const reacted = () => calls.some((c) => c.method === 'setMessageReaction');

before(async () => {
    setQueryable(pgliteQueryable(new PGlite()));
    await runMigrations();
});

test('중복확인: 등록 전 무시 → 등록 후 첫 건 👍, 같은 아이디는 알림, 하루 현황', async () => {
    assert.match(await send(201, '/중복확인 방등록', DUP), /시스템 관리자만/);
    await send(201, POST, DUP);
    assert.ok(!reacted());
    assert.match(await send(ADMIN, '/중복확인 방등록', DUP), /중복확인 방으로 등록/);

    assert.equal(await send(201, POST, DUP), '');
    assert.ok(reacted());
    await send(201, 'other.one/이영희/20대\nhttps://www.instagram.com/other.one', DUP);
    const dup = await send(202, 'EMSTIY/김지연/20대', DUP);
    assert.match(dup, /중복 인스타[\s\S]*emstiy[\s\S]*처음: U201/);
    assert.match(await send(203, 'https://www.instagram.com/emstiy', DUP), /이미 2번 올라옴/);
    assert.equal(await send(201, '오늘 다들 수고했어요', DUP), '');

    calls = [];
    await sendDailyInstaReports(bot.telegram);
    const report = calls.find((c) => c.payload.chat_id === String(DUP))!.payload.text;
    assert.match(report, /U201: 오늘 2건 · 전체 2건/);
    assert.match(report, /U202: 오늘 0건 · 전체 0건 \(오늘 중복 1\)/);
    assert.match(report, /오늘 합계 2건 · 중복 2건/);
});

test('취합: 주제별·지역별로 내용을 모음, 다른 방·지역 없는 태그는 무시', async () => {
    assert.match(await send(ADMIN, '/취합 방등록', TALLY), /취합 방으로 등록/);
    await send(201, '#출석 #도봉 12명', TALLY);
    assert.ok(reacted());
    await send(202, '#출석 #성북구 9명', TALLY);
    await send(203, '#출석 #도봉 추가 1명', TALLY);
    await send(203, '#심방 #노원 3가정', TALLY);
    await send(203, '#잡담 #아무거나', TALLY);
    await send(203, '#출석 #중랑 5명', DUP); // 취합 방 아님
    const out = await send(201, '/취합', TALLY);
    assert.match(out, /#출석<\/b> \(2\/8 지역\)/);
    assert.match(out, /• 도봉: 12명 \/ 추가 1명/);
    assert.match(out, /• 성북: 9명/);
    assert.match(out, /• 중랑: -/);
    assert.match(out, /#심방<\/b> \(1\/8 지역\)\n• 도봉: -\n• 성북: -\n• 노원: 3가정/);
    const one = await send(201, '/취합 #심방', TALLY);
    assert.match(one, /#심방/);
    assert.doesNotMatch(one, /#출석/);
    assert.match(await send(201, '/취합 11.2', TALLY), /취합할 내용이 없습니다/);
    assert.match(await send(201, '/취합', DUP), /취합 방이 아닙니다/);
});

test('카운셀링 봇 전달 주소·비밀값 — 시작할 때 DB에, 비밀값은 다시 시작해도 유지', async () => {
    assert.equal(await relaySecretOk('x'), false);
    await publishRelay('https://acc.alwaysdata.net/cdabot/webhook');
    const { url, secret } = (await query(`SELECT url, secret FROM cdabot_relay;`)).rows[0];
    assert.equal(url, 'https://acc.alwaysdata.net/cdabot/relay');
    await publishRelay('https://acc.alwaysdata.net/cdabot/webhook');
    assert.equal((await query(`SELECT secret FROM cdabot_relay;`)).rows[0].secret, secret);
    assert.equal(await relaySecretOk(secret), true);
    assert.equal(await relaySecretOk(secret.slice(1) + 'z'), false);
});

test('카운셀링 봇 전달: 취합만, 답은 돌려줘서 카운셀링 봇이 보냄, 시다봇과 같은 방에 있어도 등록한 쪽만 처리', async () => {
    const BOTH = -100333;
    assert.equal(await send(ADMIN, '/중복확인 방등록', BOTH, true), ''); // 중복확인은 카운셀링 봇으로 안 받음
    assert.match(await send(ADMIN, '/중복확인 방등록', BOTH), /중복확인 방으로 등록/); // 시다봇 직접
    assert.match(await send(ADMIN, '/취합 방등록', BOTH, true), /취합 방으로 등록/);

    await send(201, '#출석 #강북 7명', BOTH, true);
    assert.ok(reacted());
    await send(201, '#출석 #강북 7명', BOTH); // 시다봇에도 같은 글이 오지만 취합은 카운셀링 봇 쪽 방
    assert.ok(!reacted());
    assert.match(await send(201, '/취합 출석', BOTH, true), /• 강북: 7명\n/);

    await send(202, 'both.one/이영희/20대', BOTH);
    assert.ok(reacted());
    await send(202, 'both.one/이영희/20대', BOTH, true); // 카운셀링 봇 쪽은 중복확인 안 함
    assert.ok(!reacted());
    assert.match(await send(203, 'https://www.instagram.com/both.one', BOTH), /중복 인스타[\s\S]*처음: U202 \(\d+\.\d+\)$/); // '이미 2번' 없음 = 카운셀링 봇 쪽은 저장 안 됨
});
