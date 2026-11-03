// 온라인 방: 인스타 중복 알림·하루 현황, '#항목 #지역' 취합. 실행: npm test
import { pgliteQueryable } from '../test-setup';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { Telegraf, Telegram } from 'telegraf';
import { runMigrations, setQueryable } from '../db';
import { registerCore } from '../core/engine';
import { registerSida } from '../sida/bot';
import { handleRelay, parseInstaIds, parseInstaPosts, parseTally, publishRelay, registerOnline, relaySecretOk, sendDailyInstaReports } from './bot';
import { query } from '../db';

const ADMIN = 9000;
const DUP = -100111;
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
        message: { message_id: 5000 + n, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: chatId < 0 ? 'supergroup' : 'private' }, from: { id: from, is_bot: false, first_name: `U${from}` }, text },
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
    // 웹 명단 흉내 (실제 컬럼 이름 그대로) — 온라인 대원의 지역
    await query(`CREATE TABLE members ("고유번호" TEXT PRIMARY KEY, "이름" TEXT, "지역" TEXT, "구역" TEXT);`);
});

test('중복확인: 등록 전 무시 → 등록 후 첫 건 👍, 같은 아이디는 알림, 하루 현황', async () => {
    assert.match(await send(201, '/중복확인 방등록', DUP), /시스템 관리자만/);
    await send(201, POST, DUP);
    assert.ok(!reacted());
    assert.match(await send(ADMIN, '/중복확인 방등록', DUP), /온라인 전도 방으로 등록/);

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
    assert.match(report, /U201  오늘 2 · 누적 2\n/);
    assert.match(report, /U202  오늘 0 · 누적 0 \(중복 1\)/);
    assert.match(report, /오늘 2건 · 중복 2건 · 올린 대원 3명/);
});

test('중복확인 기존 목록 — "이름 / 아이디" 줄을 한 번에 넣으면 이후 중복으로 알림, 사람별 건수엔 안 들어감', async () => {
    const ROOM = -100555;
    await send(ADMIN, '/중복확인 방등록', ROOM);
    assert.match(await send(201, '/중복확인 추가\n가나 / aa.bb1', ROOM), /시스템 관리자만/);
    assert.match(await send(ADMIN, '/중복확인 추가\n0가나 / Aa.bb1\n다라 / cc_dd22\n마바 / 05_ee3\n사아 / 0000', ROOM), /기존 아이디 3개 추가/);
    assert.match(await send(ADMIN, '/중복확인 추가\n가나 / aa.bb1\n자차 / ff.gg', ROOM), /1개 추가 \(이미 있던 1개 제외\)/);
    assert.match(await send(202, 'https://www.instagram.com/cc_dd22', ROOM), /cc_dd22<\/b> — 기존 목록에 있음/);
    await send(202, 'new.one/이름/20대', ROOM);
    const report = await send(202, '/온라인', ROOM); // /중복확인 과 같은 명령
    assert.match(report, /U202  오늘 1 · 누적 1 \(중복 1\)/);
    assert.doesNotMatch(report, /기존 목록/);
});

test('중복확인 양식 칸·인스타 주소 저장 → 시스템 관리자 1:1 /중복확인 명단', async () => {
    assert.deepEqual(parseInstaPosts('아이디/이름/나이/거주지/이성친구유무/기타사항\nab_cd_01/가나/22살/서울거주(어느고, 어느대)/남자친구있음\nhttps://www.instagram.com/ab_cd_01?igsh=xyz'), [
        { id: 'ab_cd_01', region: undefined, guide: undefined, name: '가나', age: '22살', residence: '서울거주(어느고, 어느대)', relationship: '남자친구있음', memo: undefined, url: 'https://www.instagram.com/ab_cd_01' },
    ]);
    assert.equal(parseInstaPosts('ef.gh/다라/-/노원/없음/자취/본가 춘천')[0].memo, '자취/본가 춘천');
    // 텔레그램이 '__' 를 기울임으로 바꿔 줄의 밑줄이 사라져도 링크 아이디로 한 건
    assert.deepEqual(parseInstaPosts('abcd_/가나/20대초/강북/무/학생회\nhttps://www.instagram.com/abcd____?igsh=1'), [
        { id: 'abcd____', region: undefined, guide: undefined, name: '가나', age: '20대초', residence: '강북', relationship: '무', memo: '학생회', url: 'https://www.instagram.com/abcd____' },
    ]);
    assert.equal(parseInstaPosts('aa.bb/가/1/2/3\ncc.dd/나/1/2/3\nhttps://www.instagram.com/ee.ff').length, 3); // 여러 건이면 합치지 않음
    // 새 양식: 지역/인도자/아이디/이름/나이/거주지/이성친구유무/기타사항 (제목 줄은 무시)
    assert.deepEqual(parseInstaPosts('지역/인도자/아이디/이름/나이/거주지/이성친구유무/기타사항\n강북/라마/xy_z/바사/20대초/강북구예상/무/어느고, 어느대, 학생회'), [
        { id: 'xy_z', region: '강북', guide: '라마', name: '바사', age: '20대초', residence: '강북구예상', relationship: '무', memo: '어느고, 어느대, 학생회' },
    ]);

    await send(206, 'ab_cd_01/가나/22살/서울거주(어느고, 어느대)/남자친구있음\nhttps://www.instagram.com/ab_cd_01?igsh=xyz', DUP);
    assert.match(await send(206, '/중복확인 명단', DUP), /1:1 대화에서/); // 단체방에는 안 보여줌
    assert.match(await send(206, '/중복확인 명단', 206), /시스템 관리자만/);
    const list = await send(ADMIN, '/중복확인 명단', ADMIN);
    assert.match(list, /<a href="https:\/\/www\.instagram\.com\/ab_cd_01">ab_cd_01<\/a> \/ 가나 \/ 22살 \/ 서울거주\(어느고, 어느대\) \/ 남자친구있음\n    └ U206/);
    assert.doesNotMatch(list, /igsh/);
    assert.match(await send(ADMIN, '/중복확인 명단 11.2', ADMIN), /올라온 인스타가 없습니다/);
});

test('중복확인 — 캡처 사진 아래 설명(캡션)도 읽음', async () => {
    const photo = async (from: number, caption: string) => {
        calls = [];
        await bot.handleUpdate({
            update_id: ++n,
            message: { message_id: 5000 + n, date: 0, chat: { id: DUP, type: 'supergroup' }, from: { id: from, is_bot: false, first_name: `U${from}` }, photo: [{ file_id: 'x', file_unique_id: 'x', width: 1, height: 1 }], caption },
        } as any);
        return calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text).join('\n');
    };
    assert.equal(await photo(204, 'cap.one/박하나/20대/노원'), '');
    assert.ok(reacted());
    assert.match(await photo(205, 'https://www.instagram.com/cap.one'), /중복 인스타[\s\S]*처음: U204/);
    await photo(205, '');
    assert.ok(!reacted()); // 설명 없는 사진은 무시
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

test('취합: 지역 담당방 글(카운셀링 봇이 전달)을 모아 관리자 1:1 /취합 으로, 답은 돌려줘서 카운셀링 봇이 보냄', async () => {
    const DOBONG = -100401;
    const SEONGBUK = -100402;
    await send(201, '#출석 #도봉 12명', DOBONG, true);
    assert.ok(reacted());
    await send(202, '#출석 #성북구 9명', SEONGBUK, true);
    await send(203, '#출석 #도봉 추가 1명', DOBONG, true);
    await send(203, '#심방 #노원 3가정', SEONGBUK, true);
    await send(203, '#잡담 #아무거나', DOBONG, true);
    assert.ok(!reacted());
    await send(203, '#출석 #중랑 5명', DUP); // 시다봇이 직접 있는 방 글은 취합 안 함

    assert.match(await send(201, '/취합', 201, true), /시스템 관리자만/);
    assert.equal(await send(ADMIN, '/취합', DOBONG, true), ''); // 단체방에서는 안 보여줌
    assert.equal(await send(ADMIN, '/취합', ADMIN), ''); // 시다봇 1:1 에는 /취합 없음 (카운셀링 봇 1:1 에서)
    const out = await send(ADMIN, '/취합', ADMIN, true);
    assert.match(out, /#출석<\/b> \(2\/8 지역\)/);
    assert.match(out, /• 도봉: 12명 \/ 추가 1명/);
    assert.match(out, /• 성북: 9명/);
    assert.match(out, /• 중랑: -/);
    assert.match(out, /#심방<\/b> \(1\/8 지역\)\n• 도봉: -\n• 성북: -\n• 노원: 3가정/);
    const one = await send(ADMIN, '/취합 #심방', ADMIN, true);
    assert.match(one, /#심방/);
    assert.doesNotMatch(one, /#출석/);
    assert.match(await send(ADMIN, '/취합 11.2', ADMIN, true), /취합할 내용이 없습니다/);

    await send(202, 'relay.one/이영희/20대', DOBONG, true); // 카운셀링 봇 쪽은 중복확인 안 함
    assert.ok(!reacted());
});

test('웹에서 정한 실명(cdabot_online_names)이 있으면 현황·중복 알림·명단에 닉네임 대신 실명', async () => {
    const ROOM = -100666;
    await send(ADMIN, '/중복확인 방등록', ROOM);
    await send(207, 'nick.one/가나/20대', ROOM);
    await query(`INSERT INTO cdabot_online_names (poster_tg, name) VALUES (207, '김실명')`);
    assert.match(await send(208, 'https://www.instagram.com/nick.one', ROOM), /처음: 김실명/);
    const report = await send(207, '/중복확인', ROOM);
    assert.match(report, /• 김실명  오늘 1/);
    assert.doesNotMatch(report, /U207/);
    assert.match(await send(ADMIN, '/중복확인 명단', ADMIN), /└ 김실명/);
});

test('23:50 현황 — 웹에서 명단과 연결한 대원은 지역별로 (정해진 지역 순서, 미연결은 맨 끝)', async () => {
    const ROOM = -100777;
    await send(ADMIN, '/중복확인 방등록', ROOM);
    await query(`INSERT INTO members VALUES ('M1', '김강북', '강북', '2-3'), ('M2', '이노원', '노원', '1-1'), ('M3', '박강북', '강북', '2-5')`);
    await query(`INSERT INTO cdabot_online_names (poster_tg, name, member_code) VALUES (301, '김강북', 'M1'), (302, '이노원', 'M2'), (303, '박강북', 'M3')`);
    await send(301, 'r.one/가/1/2/3', ROOM);
    await send(301, 'r.two/가/1/2/3', ROOM);
    await send(302, 'r.three/가/1/2/3', ROOM);
    assert.match(await send(303, 'r.one/가/1/2/3', ROOM), /처음: 김강북/); // 중복 (실명이 여러 명 있어도)
    await send(304, 'r.four/가/1/2/3', ROOM); // 연결 안 된 대원
    calls = [];
    await sendDailyInstaReports(bot.telegram);
    const report = calls.find((c) => c.payload.chat_id === String(ROOM))!.payload.text as string;
    assert.match(report, /온라인 전도 현황<\/b>\n오늘 4건 · 중복 1건 · 올린 대원 4명/);
    assert.match(report, /🔹 <b>노원<\/b> — 오늘 1건 · 누적 1건\n• 이노원  오늘 1 · 누적 1\n\n🔹 <b>강북<\/b> — 오늘 2건 · 누적 2건\n• 김강북  오늘 2 · 누적 2\n• 박강북  오늘 0 · 누적 0 \(중복 1\)/);
    assert.match(report, /\n\n❔ <b>지역 미연결<\/b> — 오늘 1건 · 누적 1건\n• U304  오늘 1 · 누적 1$/);
    assert.match(await send(ADMIN, '/중복확인 명단', ADMIN), /r\.three<\/b> \/ 가 \/ 1 \/ 2 \/ 3\n    └ 이노원/); // 명단도 실명이 여러 명일 때
});
