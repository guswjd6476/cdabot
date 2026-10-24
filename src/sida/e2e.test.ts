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
import { createOrg, getGroupOrg, getMember, getSettings, loadSession, saveSession, setSetting, upsertMembership, upsertUser } from '../core/store';
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
    if (method === 'getChatAdministrators') return [{ status: 'creator', user: { id: 301 } }];
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
// 대원은 단체방, 관리자(시스템 관리자·301 팀 관리자)는 1:1 대화가 기본
const home = (from: number) => (from === ADMIN || from === 301 ? from : GROUP);
async function send(from: number, text: string, mid = ++messageId, chatId = home(from)) {
    calls = [];
    await bot.handleUpdate({ update_id: ++updateId, message: { message_id: mid, date: Math.floor(Date.now() / 1000), chat: chat(from, chatId), from: user(from), text } } as any);
    return texts();
}
async function press(from: number, data: string, chatId = home(from)) {
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

test('[1-4][7] 활동 시간 제출 — 한 메시지 입력, 겹침, 활동 불가, 자정 정책, 수정', async () => {
    assert.match(await send(101, '/특전대 제출'), /받는 주차가 없습니다/);
    assert.match(await send(ADMIN, '/특전대 주차시작 2026.10.26'), /10\/26~11\/1 주차 활동 시간 취합을 시작/);
    assert.match(await send(101, '/특전대 제출'), /\/활동시간\n월\/12-14,18-20/); // 양식 안내
    assert.match(await send(101, '/활동시간'), /한 줄에 한 요일/); // 상위 명령만 보내면 안내
    assert.match(await send(101, '/활동시간\n월/22:00~02:00'), /자정을 넘는 구간은 지원하지 않으니/);
    const out = await send(101, '/활동시간\n월/09:00~12:00, 14:00~17:00\n화/09:00-12:00,11:00~14:00\n수/불가\n목/9-11,13:00~15:00,19:00~21:00\n금/10:00~13:00');
    assert.match(out, /제출 완료/);
    assert.match(out, /화 10\/27: .* <b>5시간<\/b> ⚠️ 미충족/); // 겹치는 시간은 한 번만
    assert.match(out, /주간 활동 가능 시간 합계: <b>20시간<\/b>/); // 6+5+0+6+3
    assert.match(out, /미달 요일: 화, 금/);
    assert.match(out, /안 적은 요일\(토, 일\): 활동 불가로 저장/);
    assert.ok(!calls.some((c) => c.payload?.reply_markup), '버튼 없음');

    const p = (await S.getPeriodByWeek(1, '2026-10-26'))!;
    const mine = (await S.getSubmissions(p.id)).get(await uid(101))!;
    assert.equal(mine.days[3].unavailable, true);
    assert.deepEqual(mine.days[1].slots, [
        [540, 720],
        [840, 1020],
    ]);

    // 수정: 월요일만 다시 보내면 월요일만 바뀌고 나머지는 그대로
    assert.match(await send(101, '/활동시간 월/09:00~12:00'), /수정 완료[\s\S]*기존 제출 그대로/);
    assert.match(await send(101, '/특전대 내현황'), /주간 활동 가능 시간 합계: <b>17시간<\/b>/);
});

test('[6][17] 12명 시간표 · 미제출 · 부족시간 · CSV, 시간표와 개인 합계 일치', async () => {
    const p = (await S.getPeriodByWeek(1, '2026-10-26'))!;
    for (let i = 1; i <= 11; i++) {
        await send(ADMIN, `/특전대 등록 ${200 + i} 대원${String(i).padStart(2, '0')}`);
        if (i > 9) continue; // 대원10, 대원11 은 미제출
        const days: S.WeekDays = {};
        for (const w of [1, 2, 3, 4, 5, 6, 7]) {
            const s = 6 + ((i + w) % 6); // 대원마다 다른 시작 시각
            days[w] = i === 5 && w === 2 ? { unavailable: true, slots: [] } : { unavailable: false, slots: [[s * 60, (s + 3) * 60], [(s + 4) * 60, (s + 5 + (i % 4)) * 60]] };
        }
        await S.saveSubmission(p.id, await uid(200 + i), days);
    }
    const out = await send(ADMIN, '/특전대 시간표 2026.10.26');
    assert.match(out, /대원 13명 · 제출 10명 · 미제출 3명/); // 12명 + 관리자김
    assert.match(out, /\[월 10\/26\]/);
    assert.match(out, /\[일 11\/1\]/);
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
    assert.match(short, /활동 불가로 제출<\/b>\n• U101: 수, 토, 일\n• 대원05: 화/);

    await press(ADMIN, `sd:tc:${p.id}`);
    const [tt, personal] = docs();
    assert.ok(tt.startsWith('﻿요일,날짜,시작,종료,인원,활동 가능 대원\r\n월,2026-10-26,'));
    assert.match(personal, /U101,3,미충족,5,미충족,,활동 불가,6,충족,3,미충족,,활동 불가,,활동 불가,17\r\n/);
});

test('한 메시지로 일주일 활동 시간 입력 — 적은 요일만 반영, 처음이면 나머지는 활동 불가', async () => {
    const p = (await S.getPeriodByWeek(1, '2026-10-26'))!;
    assert.match(await send(211, '/활동시간\n월/09:00-14:00,18:00 화/12:00-14:00'), /월요일: 형식을 알 수 없습니다: "18:00"/); // 끝 시각은 추측하지 않음
    assert.equal((await S.getSubmissions(p.id)).has(await uid(211)), false); // 틀리면 저장 안 됨
    const out = await send(211, '/활동시간\n월/09:00-14:00,18:00-21:00 화/12:00-14:00 수/불가');
    assert.match(out, /제출 완료/);
    assert.match(out, /주간 활동 가능 시간 합계: <b>10시간<\/b>/);
    assert.match(out, /안 적은 요일\(목, 금, 토, 일\): 활동 불가로 저장/);
    const days = (await S.getSubmissions(p.id)).get(await uid(211))!.days;
    assert.deepEqual(days[1].slots, [[540, 840], [1080, 1260]]);
    assert.deepEqual([days[3].unavailable, days[7].unavailable], [true, true]);
    // 다시 보내면 적은 요일만 바뀌고 나머지는 기존 제출 유지
    assert.match(await send(211, '/활동시간 목/10-16'), /기존 제출 그대로/);
    const again = (await S.getSubmissions(p.id)).get(await uid(211))!.days;
    assert.deepEqual([again[1].slots, again[4].slots], [days[1].slots, [[600, 960]]]);
    assert.equal(await send(211, '월요일에 봐요'), ''); // 일반 대화는 무시
    assert.equal(await send(211, '월/9-12 화/불가'), ''); // /활동시간 없이 보낸 양식도 무시 (대화와 안 섞이게)
    assert.match(await send(211, '/활동시간 내일 할게요'), /요일\/시간 형식으로/);
    await S.saveSubmission(p.id, await uid(211), {}); // 이후 테스트 기준(대원11 미제출) 유지
});

test('[8][9][11] 발굴건·찾기건 한 줄 양식 — 자동 정리, 빠진 칸만 질문, 중복 방지', async () => {
    const form = '❗️발굴건\n발/홍길동/01012345678/20대 중/남/서울/1팀/김철수/전단지/+10.28 19시,강남역';
    const r1 = await send(101, form, 5000);
    assert.match(r1, /자동 정리 결과 — 발굴건[\s\S]*연락처: 010-1234-5678/);
    assert.match(r1, /10\. 2차 만남 장소: 강남역/);
    assert.match(r1, /결과 확인/);
    assert.match(await press(101, 'sd:rs:ok'), /발굴건 결과 #\d+ 저장 완료/);
    assert.match(await send(101, form, 5000), /이미 저장/); // 같은 메시지 재처리
    assert.match(await press(101, 'sd:rs:ok'), /진행 중인 입력이 없습니다/); // 확인 버튼 두 번
    assert.equal((await S.listResults(1)).length, 1);

    // 여러 건 한 번에: 줄마다 바로 저장, 이미 등록된 사람·같은 메시지 안 중복은 제외
    const bulk = await send(
        101,
        '발/테스트/1234/20대초/여/강북/1/강현정/노방\n발/테스트2/2234/20대초/여/강북/1/강현정/노방\n발/테스트3/4234/20대초/여/강북/1/강현정/노방\n' +
            '발/홍길동/010 1234 5678/20대중/남/서울/1팀/김철수/전단지\n발/테스트2/2234/20대초/여/강북/1/강현정/노방',
        5100
    );
    assert.match(bulk, /결과 3건 저장/);
    assert.match(bulk, /#\d+ 발굴건 1번째 줄 테스트\n/); // 연락처 뒷자리 4자리 OK, 2차 만남은 없어도 빈 칸 아님
    assert.match(bulk, /중복 제외 2건[\s\S]*4번째 줄 홍길동\n5번째 줄 테스트2/);
    const added: S.ResultRow[] = (await S.listResults(1)).filter((r) => r.name?.startsWith('테스트'));
    assert.deepEqual(added.map((r) => [r.name, r.phone, r.age_group, r.tool]).sort(), [
        ['테스트', '1234', '20대 초', '노방'],
        ['테스트2', '2234', '20대 초', '노방'],
        ['테스트3', '4234', '20대 초', '노방'],
    ]);
    assert.match(await send(101, '발/테스트/1234/20대초'), /이미 등록된 발굴건/); // 한 건짜리도 중복이면 저장 안 함
    assert.match(await send(101, '발/테스트3/010-5555-4234\n발/테스트3/9999'), /결과 1건 저장[\s\S]*2번째 줄 테스트3[\s\S]*중복 제외 1건[\s\S]*1번째 줄/); // 전체 번호여도 뒷자리로 비교
    for (const r of (await S.listResults(1)).filter((x) => x.phone === '9999')) added.push(r);
    assert.match(await send(101, '발/테스트/1234\n발/테스트3/4234'), /결과 0건 저장[\s\S]*중복 제외 2건/); // 다시 올려도 안 늘어남
    for (const r of added) await S.deleteResult(1, r.id); // 아래 건수 검증에 영향 없게

    const r2 = await send(101, '발/김영희//25살/여/부산');
    assert.match(r2, /생년 구분은 .* 중에서 선택/); // 허용 밖 값은 확인
    assert.match(r2, /연락처, 생년 구분, 인도팀, 인도자, 도구$/m); // 빠진 칸만 (추측 없음, 2차 만남은 선택이라 안 물음)
    assert.match(await send(101, '12'), /연락처 형식을 확인/);
    assert.match(await send(101, '010-2222-3333'), /생년 구분/);
    assert.match(await press(101, 'sd:rs:pick:1'), /인도팀/);
    await press(101, 'sd:rs:skip');
    await press(101, 'sd:rs:skip');
    const review = await send(101, '책자');
    assert.match(review, /3\. 생년 구분: 20대 중/);
    assert.match(review, /6\. 인도팀: <i>\(미입력\)<\/i>/);
    await press(101, 'sd:rs:ok');
    const [second] = await S.listResults(1);
    assert.deepEqual([second.kind, second.phone, second.age_group, second.team, second.tool], ['dig', '010-2222-3333', '20대 중', null, '책자']);

    // 찾기건
    const r3 = await send(101, '찾/이몽룡/990315/대전/3팀/성춘향/11월');
    assert.match(r3, /찾기건[\s\S]*2\. 생년월일: 990315[\s\S]*6\. 목표월: 11월/);
    await press(101, 'sd:rs:ok');
    const [find] = await S.listResults(1);
    assert.deepEqual([find.kind, find.birth_date, find.target_month, find.phone], ['find', '990315', '11월', null]);

    // 단계별 입력 (양식 고르기 → 칸마다 질문)
    assert.match(await send(101, '/특전대 결과'), /어떤 결과인가요/);
    assert.match(await press(101, 'sd:rs:form:dig'), /발굴건<\/b> \[1\/10\][\s\S]*이름/);
    for (const v of ['박영수', '010-3333-4444']) await send(101, v);
    await press(101, 'sd:rs:pick:4'); // 모름
    await press(101, 'sd:rs:pick:0'); // 성별 목록 첫 값
    for (const v of ['서울', '2팀', '홍길동', '전단지', '10.30 15시', '시청역']) await send(101, v);
    assert.match(await press(101, 'sd:rs:ok'), /저장 완료/);
    assert.equal((await S.listResults(1)).length, 4);
});

test('[10][12] 결과 수정이 일일 보고서·검색에 반영, 가능 시간과 결과 건수는 따로', async () => {
    const first = (await S.listResults(1)).find((r) => r.name === '홍길동')!;
    await press(101, `sd:rs:edit:${first.id}`);
    await press(101, 'sd:rs:ed');
    assert.match(await press(101, 'sd:rs:fx:region'), /인도지역/);
    assert.match(await send(101, '대구'), /5\. 인도지역: 대구/);
    assert.match(await press(101, 'sd:rs:ok'), /수정 완료/);
    const log = (await query(`SELECT detail FROM cdabot_audit_logs WHERE action = 'result.update';`)).rows[0].detail;
    assert.deepEqual(log, { changed: ['region'] }); // 감사 로그에 개인정보 값은 남기지 않음

    // 이번 주 앞선 날 결과 1건 (누적·요일별 확인용)
    const ws = nowKst().startOf('day').subtract((nowKst().day() + 6) % 7, 'day');
    const monId = (await S.insertResult({ orgId: 1, userId: await uid(205), kind: 'find', date: ws.format('YYYY-MM-DD'), values: { name: '월요일' }, dedupKey: 't:mon' }))!;
    const day = await send(ADMIN, '/특전대 오늘현황');
    assert.match(day, /1\. 당일 결과<\/b> — 총 4건 \(발 3건 \(만남확정 2건\) · 찾 1건\)\n• U101: 발 3건 \(만남확정 2건\) · 찾 1건\n• 0건: /); // 대원별, 2차 만남 일시가 있는 발굴 = 만남확정
    assert.match(day, /2\. 이번 주 누적<\/b> \(.*\) — 총 5건 \(발 3건 \(만남확정 2건\) · 찾 2건\)\n• U101: 발 3건 \(만남확정 2건\) · 찾 1건\n• 대원05: 발 0건 · 찾 1건/);
    if (ws.format('YYYY-MM-DD') !== nowKst().format('YYYY-MM-DD')) assert.match(day, /3\. 요일별<\/b>\n• 월 .*: 발 0건 · 찾 1건/);
    await S.deleteResult(1, monId);
    assert.match(day, /<b>발굴건<\/b> 3건[\s\S]*<b>찾기건<\/b> 1건\n• 인도지역: 대전 1/);
    const regionLine = day.match(/인도지역: (.*)/)![1]; // 발굴건 쪽
    assert.deepEqual(regionLine.split(' · ').sort(), ['대구 1', '부산 1', '서울 1']); // 수정 전 값(서울→대구)은 사라짐
    assert.match(day, /인도팀: (1팀 1 · 2팀 1|2팀 1 · 1팀 1) · \(미입력\) 1/); // 미입력은 맨 뒤 별도
    assert.match(await send(ADMIN, '/특전대 결과검색 인도지역:대구'), /총 <b>1<\/b>건/);
    assert.match(await send(ADMIN, `/특전대 결과검색 기간:${TODAY}~${TODAY} 도구:전단`), /총 <b>2<\/b>건/);
    assert.match(await send(ADMIN, '/특전대 결과검색 종류:찾기'), /총 <b>1<\/b>건/);

    const people = await send(ADMIN, '/특전대 개인현황');
    assert.match(people, /<b>U101<\/b>\n.*결과 4건\n.*주간 17시간 · 결과 4건/);
    assert.match(people, /<b>대원10<\/b>\n.*결과 0건\n.*주간 ⏳ 미제출 · 결과 0건/);
});

test('[16] 개인정보 — 권한 없는 관리자에게 연락처 비공개, CSV 에서도 제외', async () => {
    const plain = await send(301, '/특전대 결과검색 인도지역:대구');
    assert.ok(!plain.includes('010-1234-5678') && !plain.includes('홍길동'));
    assert.match(plain, /홍\*동 · 🔒/);
    assert.match(await send(301, '/특전대 결과검색 이름:홍'), /개인정보 조회 권한이 필요/);
    assert.match(await press(301, `sd:td:${nowKst().format('YYYY-MM-DD')}`), /권한이 없습니다/);
    await press(301, 'sd:sc');
    assert.ok(docs()[0].startsWith('﻿결과ID,종류,활동날짜,제출 대원,생년 구분,성별,'));
    assert.ok(!docs()[0].includes('010-'));
    assert.ok(!(await send(301, '/특전대 결과검색 종류:찾기')).includes('990315'), '생년월일도 개인정보');

    await send(ADMIN, '/특전대 결과검색 인도지역:대구');
    await press(ADMIN, 'sd:sc');
    assert.match(docs()[0], /^﻿결과ID,종류,활동날짜,제출 대원,이름,연락처,생년 구분,생년월일,.*\r\n\d+,발굴건,\d{4}-\d{2}-\d{2},U101,홍길동,010-1234-5678,20대 중,,남,대구,1팀,김철수,전단지,10\.28 19시,강남역,,/);
    assert.ok((await query(`SELECT 1 FROM cdabot_audit_logs WHERE action = 'pii.export';`)).rows.length);
});

test('단체방(대원) / 1:1 대화(관리자) — 장소 안내, 남의 버튼 차단, 개인정보 상세는 1:1로', async () => {
    const dm = (from: number, text: string) => send(from, text, ++messageId, from);
    // 장소가 틀리면 안내
    assert.match(await dm(101, '/특전대 제출'), /단체방에서 사용해주세요/);
    assert.match(await dm(101, '발/가/010-1111-2222'), /단체방에 올려주세요/);
    assert.match(await send(ADMIN, '/특전대 시간표', ++messageId, GROUP), /1:1 대화에서 사용해주세요/);
    assert.match(await press(ADMIN, 'sd:tc:1-0', GROUP), /1:1 대화에서 사용해주세요/);
    assert.match(await send(101, '/특전대 시간표'), /권한이 없습니다/); // 권한 없는 기능은 장소와 무관하게 거부
    await send(ADMIN, '/특전대');
    assert.ok(labels().includes('🗓 전체 활동 시간표') && !labels().includes('📝 활동 시간 제출'), '1:1 메뉴는 관리자 기능만');
    await send(101, '/특전대');
    assert.ok(labels().includes('📝 활동 시간 제출') && !labels().includes('🗓 전체 활동 시간표'), '단체방 메뉴는 대원 기능만');

    assert.match(await send(205, '/특전대 결과'), /어떤 결과인가요/);
    const data = calls.flatMap((c) => c.payload?.reply_markup?.inline_keyboard?.flat() ?? []).map((b: any) => b.callback_data);
    assert.ok(data.length && data.every((d: string) => d.endsWith('~205')), '버튼에 연 사람 표시');
    assert.equal(calls[0].payload.reply_parameters.message_id, messageId); // 원래 메시지에 답장

    assert.equal(await send(101, '오늘 다들 수고했어요'), ''); // 다른 사람의 대화는 입력으로 먹지 않음
    assert.equal(await dm(205, '9'), ''); // 다른 방(1:1)에서는 이어지지 않음
    assert.match(await press(205, 'sd:rs:form:find~205'), /찾기건[\s\S]*이름/);
    await press(101, 'sd:rs:cx~205');
    assert.ok(calls.some((c) => c.method === 'answerCallbackQuery' && c.payload.show_alert), '남의 버튼은 차단');
    assert.match(await press(205, 'sd:rs:cx~205'), /취소/);

    // 단체방 자유 형식 결과 → 저장
    assert.match(await send(205, '발/방철수/010-5555-6666/30대/남/광주/3팀/김/책/10.31 14시,광주역'), /결과 확인/);
    assert.match(await press(205, 'sd:rs:ok~205'), /저장 완료/);
    const mine = await send(205, '/특전대 내결과');
    assert.match(mine, /내 결과<\/b> 최근 7일 — 총 \d+건 \(발 \d+건 \(만남확정 1건\) · 찾 \d+건\)\n\n<b>\d+\/\d+ \(.\)<\/b> 발 \d+건 \(만남확정 1건\) · 찾 \d+건\n#\d+ 발\/방철수\/010-5555-6666\/30대\/남\/광주\/3팀\/김\/책\/\+10\.31 14시,광주역/);

    // 30분 넘게 방치된 입력은 단체방 대화를 먹지 않음
    await send(205, '/특전대 결과');
    const sess = await loadSession(205);
    sess.flow.at = Date.now() - 31 * 60 * 1000;
    await saveSession(205, sess);
    assert.equal(await send(205, 'ㅋㅋ'), '');

    // 관리자 1:1: 상세 결과·CSV 는 1:1 로
    assert.match(await send(ADMIN, '/특전대 결과검색 인도지역:광주'), /010-5555-6666/);
    await press(ADMIN, `sd:td:${nowKst().format('YYYY-MM-DD')}`);
    assert.ok(calls.some((c) => c.method === 'sendMessage' && c.payload.chat_id === ADMIN && /상세 결과/.test(c.payload.text)));
    assert.ok(calls.some((c) => c.method === 'sendDocument' && c.payload.chat_id === ADMIN));

    // 가입 요청: 단체방에는 승인 버튼 없음, 관리자 1:1 로 알림 → 승인
    assert.match(await send(606, '/특전대'), /등록되어 있지 않습니다/);
    await press(606, 'sd:jo:1~606');
    assert.ok(!calls.some((c) => c.payload.chat_id === GROUP && c.payload.reply_markup), '단체방에 승인 버튼 없음');
    const note = calls.find((c) => c.method === 'sendMessage' && String(c.payload.chat_id) === String(ADMIN))!;
    const approve = note.payload.reply_markup.inline_keyboard.flat().find((b: any) => b.text.includes('승인')).callback_data;
    assert.match(await press(101, approve), /권한이 없습니다/);
    assert.match(await press(ADMIN, approve), /✅ 승인/);
});

test('등록된 단체방에서는 가입 요청 없이 자동 대원 등록', async () => {
    const ROOM = -100777;
    assert.match(await send(707, '/특전대', ++messageId, ROOM), /등록되어 있지 않습니다/); // 등록 전
    assert.match(await send(101, '/특전대 방등록', ++messageId, ROOM), /권한이 없습니다/); // 대원은 불가
    assert.match(await send(ADMIN, '/특전대 방등록'), /단체방에서 사용해주세요/); // 1:1 에서는 불가
    assert.match(await send(ADMIN, '/특전대 방등록', ++messageId, ROOM), /자동 등록/);

    assert.match(await send(707, '/특전대', ++messageId, ROOM), /U707 \(대원\)/); // 가입 요청했던 사람도 바로 활성
    assert.match(await send(808, '/특전대 제출', ++messageId, ROOM), /활동 시간을 받는 주차|한 줄에 한 요일/); // 처음 온 사람도 바로 사용
    const m = (await getMember(1, S.MODULE_KEY, { telegramId: '808' }))!;
    assert.equal(m.status, 'active');
    assert.deepEqual(m.perms, ['member']); // 관리자 권한은 자동으로 주지 않음

    assert.equal(await send(828, '안녕하세요 오늘 화이팅', ++messageId, ROOM), ''); // 일반 대화엔 답하지 않지만
    assert.equal((await getMember(1, S.MODULE_KEY, { telegramId: '828' }))?.status, 'active'); // 대원으로 등록됨

    // 주제(토픽)를 켜면 텔레그램이 방 ID를 바꿈 → 등록·현황판이 새 ID로 옮겨감
    const NEW_ROOM = -1007770001;
    await setSetting(1, S.MODULE_KEY, 'board', { chatId: ROOM, threadId: 3 });
    calls = [];
    await bot.handleUpdate({ update_id: ++updateId, message: { message_id: ++messageId, date: Math.floor(Date.now() / 1000), chat: { id: NEW_ROOM, type: 'supergroup' }, from: user(ADMIN), migrate_from_chat_id: ROOM } } as any);
    assert.equal(await getGroupOrg(NEW_ROOM, S.MODULE_KEY), 1);
    assert.equal(await getGroupOrg(ROOM, S.MODULE_KEY), undefined);
    assert.equal((await getSettings(1, S.MODULE_KEY)).board.chatId, NEW_ROOM);
    await setSetting(1, S.MODULE_KEY, 'board', null);
    assert.equal(await send(838, '새 방에서 첫 대화', ++messageId, NEW_ROOM), '');
    assert.equal((await getMember(1, S.MODULE_KEY, { telegramId: '838' }))?.status, 'active');
    await send(ADMIN, '/특전대 방해제', ++messageId, NEW_ROOM);
    await send(ADMIN, '/특전대 방등록', ++messageId, ROOM);
    for (const id of ['828', '838']) await send(ADMIN, `/특전대 비활성 ${id}`); // 다음 테스트 인원 수에 영향 없게

    await send(ADMIN, '/특전대 비활성 808');
    assert.match(await send(808, '/특전대', ++messageId, ROOM), /비활성화된 계정/); // 비활성화는 되살아나지 않음
    assert.match(await send(909, '/특전대'), /등록되어 있지 않습니다/); // 등록 안 된 방은 기존대로

    assert.match(await send(ADMIN, '/특전대 방해제', ++messageId, ROOM), /해제/);
    assert.match(await send(919, '/특전대', ++messageId, ROOM), /등록되어 있지 않습니다/);
    await send(ADMIN, '/특전대 비활성 707'); // 다음 테스트 인원 수에 영향 없게
});

test('인원·역할 관리 — 목록에서 눌러 대원/관리자/제외, 대원만 집계', async () => {
    const ROOM = -100999;
    await send(ADMIN, '/특전대 방등록', ++messageId, ROOM);
    await send(961, '/특전대', ++messageId, ROOM); // 단체방에서 말한 사람 → 일단 대원
    await send(962, '/특전대', ++messageId, ROOM);
    const list = await send(ADMIN, '/특전대 대원');
    assert.match(list, /🪖 대원 U961 · <code>961<\/code>/);
    assert.ok(labels().includes('🪖 U962'));
    assert.ok(labels().some((l) => l.endsWith('👑')), '단체방 텔레그램 관리자 표시');
    const m962 = (await getMember(1, S.MODULE_KEY, { telegramId: '962' }))!;

    // 팀 관리자(301)는 관리자 지정 불가, 대원/제외만
    await press(301, `sd:mr:${m962.id}`);
    assert.deepEqual(labels(), ['🪖 대원', '🚫 제외', '◀ 목록']);
    assert.match(await press(301, `sd:mr:${m962.id}-manager`), /시스템 관리자만/);

    assert.match(await press(ADMIN, `sd:mr:${m962.id}-manager`), /🛠 관리자 U962/);
    assert.deepEqual((await getMember(1, S.MODULE_KEY, { id: m962.id }))!.perms, ['manager']);
    assert.doesNotMatch(await send(ADMIN, '/특전대 미제출 2026.10.26'), /U962/); // 관리자는 집계 제외
    assert.match(await send(ADMIN, '/특전대 미제출 2026.10.26'), /U961/);
    assert.match(await press(301, `sd:mr:${m962.id}-out`), /시스템 관리자만/); // 팀 관리자는 다른 관리자 못 바꿈

    const m961 = (await getMember(1, S.MODULE_KEY, { telegramId: '961' }))!;
    assert.match(await press(301, `sd:mr:${m961.id}-out`), /🚫 제외 U961/);
    assert.match(await send(961, '/특전대', ++messageId, ROOM), /비활성화된 계정/); // 제외되면 다시 말해도 대원으로 안 돌아감
    assert.doesNotMatch(await send(ADMIN, '/특전대 미제출 2026.10.26'), /U961/);
    assert.match(await press(101, `sd:mr:${m961.id}-member`), /권한이 없습니다/); // 대원은 못 바꿈

    await send(ADMIN, '/특전대 방해제', ++messageId, ROOM);
    await press(ADMIN, `sd:mr:${m962.id}-out`); // 다음 테스트 인원 수에 영향 없게
});

test('주제방 현황판 — 한 메시지를 계속 갱신, 날짜 바뀌면 새로', async () => {
    const ROOM = -100555;
    const topic = async (from: number, text: string, thread: number) => {
        calls = [];
        await bot.handleUpdate({
            update_id: ++updateId,
            message: { message_id: ++messageId, message_thread_id: thread, is_topic_message: true, date: Math.floor(Date.now() / 1000), chat: { id: ROOM, type: 'supergroup', is_forum: true }, from: user(from), text },
        } as any);
        return calls;
    };
    await send(ADMIN, '/특전대 방등록', ++messageId, ROOM);
    assert.match((await topic(101, '/특전대 현황판', 7)).map((c) => c.payload.text).join(), /권한이 없습니다/); // 대원은 불가
    const made = (await topic(ADMIN, '/특전대 현황판', 7)).find((c) => c.method === 'sendMessage')!;
    assert.equal(made.payload.message_thread_id, 7); // 현황판 주제에 올라감
    assert.match(made.payload.text, /실시간 현황판[\s\S]*당일 결과<\/b> — 총[\s\S]*이번 주 누적[\s\S]*요일별/);
    assert.ok(!made.payload.text.includes('항목별 집계'), '현황판은 대원별 건수 중심');
    const board = (await getSettings(1, S.MODULE_KEY)).board;
    assert.deepEqual([board.chatId, board.threadId, board.date], [ROOM, 7, nowKst().format('YYYY-MM-DD')]);

    // 다른 주제(결과 쓰는 곳)에 올리면 답장은 그 주제로, 현황판은 같은 메시지 수정
    const posted = await topic(101, '발/주제/5678/30대\n발/주제2/6789/30대', 9);
    assert.equal(posted.find((c) => c.method === 'sendMessage')!.payload.message_thread_id, 9);
    const edit = posted.find((c) => c.method === 'editMessageText')!;
    assert.deepEqual([edit.payload.chat_id, edit.payload.message_id], [ROOM, board.messageId]);
    assert.match(edit.payload.text, /당일 결과<\/b> — 총 \d+건[^\n]*[\s\S]*• U101: 발 \d+건[^\n]* · 찾 \d+건/);
    assert.match(edit.payload.text, /📋 오늘 올라온 결과<\/b>[\s\S]*<b>U101<\/b> 발 \d+건[^\n]* · 찾 \d+건\n[\s\S]*발\/주제\/5678\/30대\/{5}\n발\/주제2\/6789\/30대/); // 올린 양식 그대로

    await setSetting(1, S.MODULE_KEY, 'board', { ...board, date: '2000-01-01' }); // 날짜가 바뀐 것처럼
    const next = await topic(101, '/활동시간 일/10-12', 9);
    assert.ok(!next.some((c) => c.method === 'editMessageText'));
    assert.equal(next.filter((c) => c.method === 'sendMessage' && c.payload.message_thread_id === 7).length, 1); // 새 현황판

    await topic(ADMIN, '/특전대 현황판 해제', 7);
    assert.ok(!(await topic(101, '발/주제3/1111/30대\n발/주제4/2222/30대', 9)).some((c) => c.method === 'editMessageText' || c.payload?.message_thread_id === 7));
    for (const r of (await S.listResults(1)).filter((x) => x.name?.startsWith('주제'))) await S.deleteResult(1, r.id);
    await send(ADMIN, '/특전대 방해제', ++messageId, ROOM);
});

test('[14] 조직별 데이터 분리', async () => {
    const org2 = (await createOrg('제2조직'))!;
    const u = await upsertUser(401, 'U401');
    const m = await upsertMembership(org2.id, u.id, S.MODULE_KEY, '이조직대원', 'active');
    const id = (await S.insertResult({ orgId: org2.id, userId: u.id, kind: 'dig', date: nowKst().format('YYYY-MM-DD'), values: { name: '타조직', tool: '전단지' }, dedupKey: 'org2-1' }))!;
    assert.ok(!(await S.listResults(1)).some((r) => r.id === id));
    assert.equal(await S.getResult(1, id), undefined);
    assert.match(await send(301, `/특전대 결과수정 ${id}`), /찾을 수 없습니다/);
    assert.match(await press(301, `sd:ap:${org2.id}-${m.id}`), /권한이 없습니다/); // 다른 조직 요청 처리 불가
    assert.match(await send(401, '/특전대'), /제2조직/);
    assert.match(await send(401, '/특전대 결과검색'), /권한이 없습니다/);

    // 조직이 2개면 시스템 관리자는 조직을 골라 전환
    assert.match(await send(ADMIN, '/특전대 조직'), /조직을 선택/); // 조직 전환 (마지막 선택은 기억됨)
    await press(ADMIN, `core:org:special:${org2.id}`);
    assert.match(await send(ADMIN, '/특전대 결과검색 도구:전단'), /총 <b>1<\/b>건/);
    await press(ADMIN, 'core:org:special:1');
    assert.match(await send(ADMIN, '/특전대 결과검색 도구:전단'), /총 <b>2<\/b>건/);
});

test('[18] 새 주차가 지난 주차를 덮어쓰지 않음 · 마감/재개방/수정허용', async () => {
    const p1 = (await S.getPeriodByWeek(1, '2026-10-26'))!;
    const before1 = JSON.stringify([...(await S.getSubmissions(p1.id)).entries()].map(([k, v]) => [k, v.days]));
    await send(ADMIN, '/특전대 주차시작 2026.11.2');
    const out = await send(101, '/활동시간\n월/08:00~14:00');
    assert.match(out, /제출 완료<\/b> \(11\/2~11\/8\)/); // 새 주차는 빈 상태로 시작 → '수정'이 아니라 '제출'
    assert.match(out, /화, 수, 목, 금, 토, 일\): 활동 불가로 저장/);
    const p2 = (await S.getPeriodByWeek(1, '2026-11-02'))!;
    assert.equal(JSON.stringify([...(await S.getSubmissions(p1.id)).entries()].map(([k, v]) => [k, v.days])), before1);
    assert.deepEqual((await S.getSubmissions(p2.id)).get(await uid(101))!.days[1].slots, [[480, 840]]);

    assert.match(await send(ADMIN, '/특전대 마감'), /11\/2~11\/8 주차 제출을 마감/);
    assert.match(await send(ADMIN, '/특전대 마감'), /10\/26~11\/1 주차 제출을 마감/);
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
    await press(205, 'sd:rs:form:dig');
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
