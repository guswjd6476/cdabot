// 통합 테스트: 실제 봇 핸들러(Telegraf) + 실제 Postgres(PGlite) + 가짜 텔레그램 API. 실행: npm test
import { pgliteQueryable } from '../test-setup';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PGlite } from '@electric-sql/pglite';
import { Telegraf, Telegram } from 'telegraf';
import { query, runMigrations, setQueryable } from '../db';
import { registerCore } from '../core/engine';
import { createOrg, getMember, loadSession, saveSession, upsertMembership, upsertUser } from '../core/store';
import { nowKst } from '../utils';
import { registerSida } from './bot';
import * as S from './store';

const ADMIN = 9000; // test-setup 의 ADMIN_IDS
const TODAY = nowKst().format('YYYY.MM.DD');

// 텔레그램 API 호출을 가로채 기록
type Call = { method: string; payload: any };
let calls: Call[] = [];
(Telegram.prototype as any).callApi = async function (method: string, payload: any) {
    calls.push({ method, payload });
    if (method === 'getMe') return { id: 1, is_bot: true, first_name: 'sida', username: 'sidabot' };
    if (method === 'answerCallbackQuery') return true;
    return { message_id: calls.length, date: 0, chat: { id: payload.chat_id, type: 'private' }, text: payload.text };
};

function newBot() {
    const b = new Telegraf('1:TEST');
    b.botInfo = { id: 1, is_bot: true, first_name: 'sida', username: 'sidabot' } as any;
    registerCore(b);
    registerSida(b);
    return b;
}
let bot = newBot();
let updateId = 0;
let messageId = 1000;
const user = (id: number) => ({ id, is_bot: false, first_name: `U${id}` });
const texts = () =>
    calls
        .filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText')
        .map((c) => c.payload.text)
        .join('\n---\n');
const labels = () => calls.flatMap((c) => c.payload?.reply_markup?.inline_keyboard?.flat().map((b: any) => b.text) ?? []);
const docs = () => calls.filter((c) => c.method === 'sendDocument').map((c) => (c.payload.document.source as Buffer).toString('utf8'));

const GROUP = -100123;
const chat = (from: number, id = from) => ({ id, type: id < 0 ? 'supergroup' : 'private' });
async function send(from: number, text: string, mid = ++messageId, chatId = from) {
    calls = [];
    await bot.handleUpdate({ update_id: ++updateId, message: { message_id: mid, date: Math.floor(Date.now() / 1000), chat: chat(from, chatId), from: user(from), text } } as any);
    return texts();
}
async function press(from: number, data: string, chatId = from) {
    calls = [];
    await bot.handleUpdate({
        update_id: ++updateId,
        callback_query: { id: String(updateId), from: user(from), chat_instance: 'x', data, message: { message_id: 1, date: 0, chat: chat(from, chatId), text: '.' } },
    } as any);
    return texts();
}
const uid = async (tg: number, org = 1) => (await getMember(org, S.MODULE_KEY, { telegramId: String(tg) }))!.user_id;

let pg: PGlite;
before(async () => {
    pg = new PGlite();
    setQueryable(pgliteQueryable(pg));
    await runMigrations();
    await runMigrations(); // 두 번 실행해도 안전
});

test('대원 가입 요청 → 관리자 승인 → 메뉴', async () => {
    assert.match(await send(101, '/특전대'), /등록되어 있지 않습니다/);
    assert.match(await send(101, '/특전대 결과'), /등록되어 있지 않습니다/); // 미등록자는 제출 불가
    assert.match(await press(101, 'sd:jo:1'), /가입 요청을 보냈습니다/);
    assert.ok(calls.some((c) => c.method === 'sendMessage' && String(c.payload.chat_id) === String(ADMIN)), '관리자에게 알림');
    assert.match(await send(101, '/특전대'), /승인을 기다리고/);
    const m = (await getMember(1, S.MODULE_KEY, { telegramId: '101' }))!;
    assert.match(await press(ADMIN, `sd:ap:1-${m.id}`), /승인/);
    assert.match(await send(101, '/특전대'), /특전대.*\n.*U101 \(대원\)/);
    assert.ok(labels().includes('📝 활동 시간 제출'));
    assert.ok(!labels().includes('🗓 전체 활동 시간표'), '대원 메뉴에 관리자 버튼 없음');
    assert.match(await send(ADMIN, '/특전대 등록 301 관리자김'), /등록 완료/);
    assert.match(await send(ADMIN, '/특전대 권한 301 member,manager'), /팀 관리자/);
});

test('[13] 일반 대원은 관리자 전용 기능·데이터를 조회할 수 없음 (버튼 직접 호출 포함)', async () => {
    for (const cmd of ['시간표', '오늘현황', '개인현황', '결과검색', '미제출', '부족시간', '마감', '재개방', '주차시작', '대원', '등록 555 x', '권한 101 manager', '결과수정 1']) {
        assert.match(await send(101, `/특전대 ${cmd}`), /권한이 없습니다/, cmd);
    }
    for (const data of ['sd:tc:1-0', 'sd:tt:1-1', `sd:td:${TODAY}`, 'sd:sc', 'sd:sp:0', 'sd:pm:1']) {
        assert.match(await press(101, data), /권한이 없습니다/, data);
    }
    assert.match(await send(301, '/특전대 권한 101 manager'), /권한이 없습니다/); // 팀 관리자도 권한 설정은 불가
    assert.match(await send(777, '/특전대 시간표'), /등록되어 있지 않습니다/);
});

test('[1-4][7] 활동 시간 제출 흐름 — 자유 구간, 겹침, 활동 불가, 자정 정책, 최종 확인', async () => {
    assert.match(await send(101, '/특전대 제출'), /받는 주차가 없습니다/);
    assert.match(await send(ADMIN, '/특전대 주차시작 2026.10.26'), /10\/26~10\/30 주차 활동 시간 취합을 시작/);
    assert.match(await send(101, '/특전대 제출'), /월요일 10\/26/);
    assert.match(await send(101, '09:00~12:00, 14:00~17:00'), /합계\(겹침 제외\): <b>6시간<\/b> ✅ 충족/);
    assert.match(await send(101, '22:00~02:00'), /자정을 넘는 구간은 지원하지 않으니/);
    assert.match(await press(101, 'sd:av:nx'), /화요일/);
    const tue = await send(101, '09:00-12:00\n11:00~14:00');
    assert.match(tue, /<b>5시간<\/b> ⚠️ 미충족/);
    assert.match(tue, /겹치는 시간은 한 번만/);
    await press(101, 'sd:av:nx');
    assert.match(await press(101, 'sd:av:un'), /활동 불가<\/b>로 표시/);
    assert.match(await press(101, 'sd:av:nx'), /목요일/);
    assert.match(await press(101, 'sd:av:nx'), /시간을 추가하거나/); // 빈 날은 넘어갈 수 없음
    await press(101, 'sd:av:bs');
    await press(101, 'sd:av:bh:9');
    assert.match(await press(101, 'sd:av:be:9-11'), /09:00~11:00/); // 버튼 입력
    assert.match(await send(101, '13:00~15:00, 19:00~21:00'), /<b>6시간<\/b> ✅/); // 3개 구간
    await press(101, 'sd:av:nx');
    await send(101, '10:00~13:00');
    const review = await press(101, 'sd:av:nx');
    assert.match(review, /제출 내용 확인/);
    assert.match(review, /주간 활동 가능 시간 합계: <b>20시간<\/b>/); // 6+5+0+6+3
    assert.match(review, /미달 요일: 화, 금/);
    assert.match(await press(101, 'sd:av:ok'), /제출 완료/);

    const p = (await S.getPeriodByWeek(1, '2026-10-26'))!;
    const mine = (await S.getSubmissions(p.id)).get(await uid(101))!;
    assert.equal(mine.days[3].unavailable, true);
    assert.deepEqual(mine.days[1].slots, [
        [540, 720],
        [840, 1020],
    ]);

    // 수정: 기존 제출 불러와 월요일 구간 1개 삭제 → 재제출 → 집계 갱신
    assert.match(await send(101, '/특전대 제출'), /불러왔습니다/);
    await press(101, 'sd:av:dl');
    assert.match(await press(101, 'sd:av:di:1'), /<b>3시간<\/b> ⚠️ 미충족/);
    for (let i = 0; i < 5; i++) await press(101, 'sd:av:nx');
    assert.match(await press(101, 'sd:av:ok'), /수정 완료/);
    assert.match(await send(101, '/특전대 내현황'), /주간 활동 가능 시간 합계: <b>17시간<\/b>/);
});

test('[6][17] 12명 시간표 · 미제출 · 부족시간 · CSV, 시간표와 개인 합계 일치', async () => {
    const p = (await S.getPeriodByWeek(1, '2026-10-26'))!;
    for (let i = 1; i <= 11; i++) {
        await send(ADMIN, `/특전대 등록 ${200 + i} 대원${String(i).padStart(2, '0')}`);
        if (i > 9) continue; // 대원10, 대원11 은 미제출
        const days: S.WeekDays = {};
        for (const w of [1, 2, 3, 4, 5]) {
            const s = 6 + ((i + w) % 6); // 대원마다 다른 시작 시각
            days[w] = i === 5 && w === 2 ? { unavailable: true, slots: [] } : { unavailable: false, slots: [[s * 60, (s + 3) * 60], [(s + 4) * 60, (s + 5 + (i % 4)) * 60]] };
        }
        await S.saveSubmission(p.id, await uid(200 + i), days);
    }
    const out = await send(ADMIN, '/특전대 시간표 2026.10.26');
    assert.match(out, /대원 13명 · 제출 10명 · 미제출 3명/); // 12명 + 관리자김
    assert.match(out, /\[월 10\/26\]/);
    assert.match(out, /\[금 10\/30\]/);
    assert.match(out, /대원05: 🚫 활동 불가/);

    const snap = (await query(`SELECT data FROM cdabot_schedule_snapshots WHERE period_id = $1 ORDER BY id DESC LIMIT 1;`, [p.id])).rows[0].data;
    for (const [w, day] of Object.entries<any>(snap.days)) {
        for (const person of day.people) {
            const inTable = day.segments.filter((sg: any) => sg.names.includes(person.name)).reduce((sum: number, sg: any) => sum + sg.end - sg.start, 0);
            assert.equal(inTable, person.minutes, `${w}요일 ${person.name}`);
        }
    }

    assert.match(await send(ADMIN, '/특전대 미제출 2026.10.26'), /제출 10\/13명[\s\S]*대원10[\s\S]*대원11/);
    const short = await send(ADMIN, '/특전대 부족시간 2026.10.26');
    assert.match(short, /U101: 월 3시간\(-3시간\), 화 5시간\(-1시간\), 금 3시간/);
    assert.match(short, /활동 불가로 제출<\/b>\n• U101: 수\n• 대원05: 화/);

    await press(ADMIN, `sd:tc:${p.id}`);
    const [tt, personal] = docs();
    assert.ok(tt.startsWith('﻿요일,날짜,시작,종료,인원,활동 가능 대원\r\n월,2026-10-26,'));
    assert.match(personal, /U101,3,미충족,5,미충족,,활동 불가,6,충족,3,미충족,17\r\n/);
});

test('[8][9][11] 자유 형식 결과 — 자동 정리, 빠진 항목만 질문, 중복 방지', async () => {
    const form = '발: 3\n이름: 홍길동\n연락처: 01012345678\n생년: 20대 중\n성별: 남\n인도지역: 서울\n인도팀: 1팀\n인도자: 김철수\n도구: 전단지';
    const r1 = await send(101, form, 5000);
    assert.match(r1, /자동 정리 결과[\s\S]*연락처: 010-1234-5678/);
    assert.match(r1, /결과 확인/);
    assert.match(await press(101, 'sd:rs:ok'), /저장 완료/);
    assert.match(await send(101, form, 5000), /이미 저장/); // 같은 메시지 재처리
    assert.match(await press(101, 'sd:rs:ok'), /진행 중인 입력이 없습니다/); // 확인 버튼 두 번
    assert.equal((await S.listResults(1)).length, 1);

    const r2 = await send(101, '발: 2\n이름: 김영희\n생년: 25살\n성별: 여\n인도지역: 부산');
    assert.match(r2, /생년 구분은 .* 중에서 선택/); // 허용 밖 값은 확인
    assert.match(r2, /연락처, 생년 구분, 인도팀, 인도자, 도구/); // 빠진 항목만 (추측 없음)
    assert.match(await send(101, '1234'), /연락처 형식을 확인/);
    assert.match(await send(101, '010-2222-3333'), /생년 구분/);
    assert.match(await press(101, 'sd:rs:pick:1'), /인도팀/);
    await press(101, 'sd:rs:skip');
    await press(101, 'sd:rs:skip');
    const review = await send(101, '책자');
    assert.match(review, /7\. 인도팀: <i>\(미입력\)<\/i>/);
    await press(101, 'sd:rs:ok');
    const [second] = await S.listResults(1);
    assert.deepEqual([second.phone, second.age_group, second.team, second.tool], ['010-2222-3333', '20대 중', null, '책자']);

    // 단계별 입력
    await send(101, '/특전대 결과');
    for (const v of ['1', '이몽룡', '010-3333-4444']) await send(101, v);
    await press(101, 'sd:rs:pick:4'); // 모름
    await press(101, 'sd:rs:pick:0'); // 성별 목록 첫 값
    for (const v of ['서울', '2팀', '홍길동', '전단지']) await send(101, v);
    assert.match(await press(101, 'sd:rs:ok'), /저장 완료/);
    assert.equal((await S.listResults(1)).length, 3);
});

test('[10][12] 결과 수정이 일일 보고서·검색에 반영, 가능 시간과 결과 건수는 따로', async () => {
    const first = (await S.listResults(1)).find((r) => r.name === '홍길동')!;
    await press(101, `sd:rs:edit:${first.id}`);
    await press(101, 'sd:rs:ed');
    assert.match(await press(101, 'sd:rs:fx:region'), /인도지역/);
    assert.match(await send(101, '대구'), /6\. 인도지역: 대구/);
    assert.match(await press(101, 'sd:rs:ok'), /수정 완료/);
    const log = (await query(`SELECT detail FROM cdabot_audit_logs WHERE action = 'result.update';`)).rows[0].detail;
    assert.deepEqual(log, { changed: ['region'] }); // 감사 로그에 개인정보 값은 남기지 않음

    const day = await send(ADMIN, '/특전대 오늘현황');
    assert.match(day, /당일 결과<\/b> — 총 3건/);
    const regionLine = day.match(/인도지역: (.*)/)![1];
    assert.deepEqual(regionLine.split(' · ').sort(), ['대구 1', '부산 1', '서울 1']); // 수정 전 값(서울→대구)은 사라짐
    assert.match(day, /인도팀: (1팀 1 · 2팀 1|2팀 1 · 1팀 1) · \(미입력\) 1/); // 미입력은 맨 뒤 별도
    assert.match(day, /U101: .* \/ 결과 3건/);
    assert.match(await send(ADMIN, '/특전대 결과검색 인도지역:대구'), /총 <b>1<\/b>건/);
    assert.match(await send(ADMIN, `/특전대 결과검색 기간:${TODAY}~${TODAY} 도구:전단`), /총 <b>2<\/b>건/);

    const people = await send(ADMIN, '/특전대 개인현황');
    assert.match(people, /<b>U101<\/b>\n.*결과 3건\n.*주간 17시간 · 결과 3건/);
    assert.match(people, /<b>대원10<\/b>\n.*결과 0건\n.*주간 ⏳ 미제출 · 결과 0건/);
});

test('[16] 개인정보 — 권한 없는 관리자에게 연락처 비공개, CSV 에서도 제외', async () => {
    const plain = await send(301, '/특전대 결과검색 인도지역:대구');
    assert.ok(!plain.includes('010-1234-5678') && !plain.includes('홍길동'));
    assert.match(plain, /홍\*동 · 🔒/);
    assert.match(await send(301, '/특전대 결과검색 이름:홍'), /개인정보 조회 권한이 필요/);
    assert.match(await press(301, `sd:td:${nowKst().format('YYYY-MM-DD')}`), /권한이 없습니다/);
    await press(301, 'sd:sc');
    assert.ok(docs()[0].startsWith('﻿결과ID,활동날짜,제출 대원,발,생년 구분,'));
    assert.ok(!docs()[0].includes('010-'));

    await send(ADMIN, '/특전대 결과검색 인도지역:대구');
    await press(ADMIN, 'sd:sc');
    assert.match(docs()[0], /^﻿결과ID,활동날짜,제출 대원,발,이름,연락처,.*\r\n\d+,\d{4}-\d{2}-\d{2},U101,3,홍길동,010-1234-5678,20대 중,남,대구,1팀,김철수,전단지,/);
    assert.ok((await query(`SELECT 1 FROM cdabot_audit_logs WHERE action = 'pii.export';`)).rows.length);
});

test('단체방 운영 — 방에서 제출·조회, 남의 버튼 차단, 개인정보 상세는 1:1로', async () => {
    const g = (from: number, text: string) => send(from, text, ++messageId, GROUP);
    const gp = (from: number, data: string) => press(from, data, GROUP);

    assert.match(await g(205, '/특전대 결과'), /발/);
    const data = calls.flatMap((c) => c.payload?.reply_markup?.inline_keyboard?.flat() ?? []).map((b: any) => b.callback_data);
    assert.ok(data.length && data.every((d: string) => d.endsWith('~205')), '버튼에 연 사람 표시');
    assert.equal(calls[0].payload.reply_parameters.message_id, messageId); // 원래 메시지에 답장

    assert.equal(await g(101, '오늘 다들 수고했어요'), ''); // 다른 사람의 대화는 입력으로 먹지 않음
    assert.equal(await send(205, '9'), ''); // 같은 사람이라도 다른 방(1:1)에서는 이어지지 않음
    assert.match(await g(205, '7'), /이름/);
    await gp(101, 'sd:rs:cx~205');
    assert.ok(calls.some((c) => c.method === 'answerCallbackQuery' && c.payload.show_alert), '남의 버튼은 차단');
    assert.match(await gp(205, 'sd:rs:cx~205'), /취소/);

    // 단체방 자유 형식 결과 → 저장
    assert.match(await g(205, '발: 1\n이름: 방철수\n연락처: 010-5555-6666\n생년: 30대\n성별: 남\n인도지역: 광주\n인도팀: 3팀\n인도자: 김\n도구: 책'), /결과 확인/);
    assert.match(await gp(205, 'sd:rs:ok~205'), /저장 완료/);

    // 30분 넘게 방치된 입력은 단체방 대화를 먹지 않음
    await g(205, '/특전대 결과');
    const sess = await loadSession(205);
    sess.flow.at = Date.now() - 31 * 60 * 1000;
    await saveSession(205, sess);
    assert.equal(await g(205, 'ㅋㅋ'), '');

    // 관리자: 단체방 화면에는 이름·연락처 가림, 상세·CSV 는 1:1 로
    const found = await g(ADMIN, '/특전대 결과검색 인도지역:광주');
    assert.match(found, /총 <b>1<\/b>건/);
    assert.ok(!found.includes('010-5555-6666') && !found.includes('방철수'));
    await gp(ADMIN, `sd:td:${nowKst().format('YYYY-MM-DD')}~${ADMIN}`);
    assert.ok(calls.some((c) => c.method === 'sendMessage' && c.payload.chat_id === ADMIN && /상세 결과/.test(c.payload.text)));
    assert.ok(calls.some((c) => c.method === 'sendDocument' && c.payload.chat_id === ADMIN));
    assert.ok(!calls.some((c) => c.payload.chat_id === GROUP && /010-/.test(c.payload.text || '')));
    assert.match(texts(), /1:1 대화로 보냈습니다/);
    await gp(ADMIN, `sd:sc~${ADMIN}`);
    assert.ok(calls.some((c) => c.method === 'sendDocument' && c.payload.chat_id === ADMIN), '개인정보 CSV 도 1:1');

    // 가입 요청은 방에서 관리자가 바로 승인
    assert.match(await g(606, '/특전대'), /등록되어 있지 않습니다/);
    await gp(606, 'sd:jo:1~606');
    const approve = calls.flatMap((c) => c.payload?.reply_markup?.inline_keyboard?.flat() ?? []).find((b: any) => b.text.includes('승인'));
    assert.match(approve.callback_data, /^sd:ap:1-\d+$/); // 관리자 누구나 누를 수 있게 표시 없음
    assert.match(await gp(101, approve.callback_data), /권한이 없습니다/);
    assert.match(await gp(ADMIN, approve.callback_data), /✅ 승인/);
});

test('[14] 조직별 데이터 분리', async () => {
    const org2 = (await createOrg('제2조직'))!;
    const u = await upsertUser(401, 'U401');
    const m = await upsertMembership(org2.id, u.id, S.MODULE_KEY, '이조직대원', 'active');
    const id = (await S.insertResult({ orgId: org2.id, userId: u.id, date: nowKst().format('YYYY-MM-DD'), values: { name: '타조직', tool: '전단지' }, dedupKey: 'org2-1' }))!;
    assert.ok(!(await S.listResults(1)).some((r) => r.id === id));
    assert.equal(await S.getResult(1, id), undefined);
    assert.match(await send(301, `/특전대 결과수정 ${id}`), /찾을 수 없습니다/);
    assert.match(await press(301, `sd:ap:${org2.id}-${m.id}`), /권한이 없습니다/); // 다른 조직 요청 처리 불가
    assert.match(await send(401, '/특전대'), /제2조직/);
    assert.match(await send(401, '/특전대 결과검색'), /권한이 없습니다/);

    // 조직이 2개가 되면 시스템 관리자는 조직을 골라야 함
    assert.match(await send(ADMIN, '/특전대'), /조직을 선택/);
    await press(ADMIN, `core:org:special:${org2.id}`);
    assert.match(await send(ADMIN, '/특전대 결과검색 도구:전단'), /총 <b>1<\/b>건/);
    await press(ADMIN, 'core:org:special:1');
    assert.match(await send(ADMIN, '/특전대 결과검색 도구:전단'), /총 <b>2<\/b>건/);
});

test('[18] 새 주차가 지난 주차를 덮어쓰지 않음 · 마감/재개방/수정허용', async () => {
    const p1 = (await S.getPeriodByWeek(1, '2026-10-26'))!;
    const before1 = JSON.stringify([...(await S.getSubmissions(p1.id)).entries()].map(([k, v]) => [k, v.days]));
    await send(ADMIN, '/특전대 주차시작 2026.11.2');
    assert.doesNotMatch(await send(101, '/특전대 제출'), /불러왔습니다/); // 새 주차는 빈 상태로 시작
    await send(101, '08:00~14:00');
    for (let i = 0; i < 4; i++) {
        await press(101, 'sd:av:nx');
        await press(101, 'sd:av:un');
    }
    await press(101, 'sd:av:nx');
    assert.match(await press(101, 'sd:av:ok'), /11\/2~11\/6/);
    const p2 = (await S.getPeriodByWeek(1, '2026-11-02'))!;
    assert.equal(JSON.stringify([...(await S.getSubmissions(p1.id)).entries()].map(([k, v]) => [k, v.days])), before1);
    assert.deepEqual((await S.getSubmissions(p2.id)).get(await uid(101))!.days[1].slots, [[480, 840]]);

    assert.match(await send(ADMIN, '/특전대 마감'), /11\/2~11\/6 주차 제출을 마감/);
    assert.match(await send(ADMIN, '/특전대 마감'), /10\/26~10\/30 주차 제출을 마감/);
    assert.match(await send(101, '/특전대 제출'), /받는 주차가 없습니다/);
    await send(ADMIN, '/특전대 수정허용 101');
    assert.match(await send(101, '/특전대 제출'), /11\/2/); // 허용된 사람만 마감 후 수정
    assert.match(await send(205, '/특전대 제출'), /받는 주차가 없습니다/);
    assert.match(await send(ADMIN, '/특전대 재개방 2026.11.2'), /다시 열었습니다/);
    assert.match(await send(205, '/특전대 제출'), /11\/2/);
});

test('[15] 봇 재시작 후에도 제출 데이터·진행 중 입력 유지', async () => {
    // (1) 봇 인스턴스 재생성(메모리 초기화) 후 진행 중이던 입력 이어서
    await send(205, '/특전대 결과');
    await send(205, '5');
    bot = newBot();
    assert.match(await send(205, '박지성'), /연락처/);

    // (2) 파일 DB를 닫았다 다시 열어도 데이터 유지
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidabot-'));
    let disk = new PGlite(dir);
    setQueryable(pgliteQueryable(disk));
    await runMigrations();
    const u = await upsertUser(42, 'x');
    const p = (await S.createPeriod(1, '2026-10-26'))!;
    await S.saveSubmission(p.id, u.id, { 1: { unavailable: false, slots: [[540, 900]] } });
    await saveSession(42, { flow: { kind: 'avail', day: 3 } });
    await disk.close();
    disk = new PGlite(dir);
    setQueryable(pgliteQueryable(disk));
    assert.deepEqual((await S.getSubmissions(p.id)).get(u.id)!.days[1].slots, [[540, 900]]);
    assert.deepEqual((await loadSession(42)).flow, { kind: 'avail', day: 3 });
    await disk.close();
    fs.rmSync(dir, { recursive: true, force: true });
    setQueryable(pgliteQueryable(pg));
});
