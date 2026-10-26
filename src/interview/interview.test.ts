// 인터뷰 추적: 결과지 파싱 + 실제 봇 핸들러·Postgres(PGlite)로 저장 → 행정(students) 연결 → 현황·권한. 실행: npm test
import { pgliteQueryable } from '../test-setup';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { Telegraf, Telegram } from 'telegraf';
import { query, runMigrations, setQueryable } from '../db';
import { registerCore } from '../core/engine';
import { setSetting, upsertMembership, upsertUser } from '../core/store';
import { registerSida } from '../sida/bot';
import { registerInterview } from './bot';
import { parseInterviewSheet, sheetKind } from './parse';
import { MODULE_KEY, purgeExpiredInterviews } from './store';
import { createPeriod } from '../sida/store';
import { ageGroup, birth6, genderOf, interviewToForms, meetOf } from './toSida';

const ADMIN = 9000; // test-setup 의 ADMIN_IDS
const GROUP = -100777;

// 실제 결과지와 같은 모양 (이름·번호는 가짜)
const SHEET = `📌 향수 인터뷰 양식

✔️ 당터뷰어 필독
1) 코칭 신청 X여도 최대한 연락처를 확보 한다

✔️ 당터뷰 후 바로 누적
섭외자/지역/인도자/인터뷰자/다음 만남예정일, 장소/간단정보

▪️후속연결O
#김가람/성북/양하늘, 강구름/한솔/추후연락/01년생, ISTP, 010-1111-2222
#이나래/중랑/한솔/목,금 오후 가능/생년월일: 20030718
본가 지방, 기숙사 거주
#박다솜/-/-/한솔/2주 뒤 주말

▪️후속연결 보류
#최미르/노원/문별/한솔/2027.1월 연락 010 3333 4444
https://t.me/c/1/2

▪️후속연결X
#정보라/주서영/한솔/시간이 없다고 함
#홍새봄/성북/한솔/관심X`;

test('결과지 파싱 — 구간별 후속 상태, 칸 수가 다른 줄, 여러 줄 메모, 연락처·생년월일', () => {
    const xs = parseInterviewSheet(SHEET);
    assert.deepEqual(
        xs.map((x) => [x.name, x.followUp, x.region, x.guides.join(','), x.interviewer]),
        [
            ['김가람', 'O', '성북', '양하늘,강구름', '한솔'],
            ['이나래', 'O', '중랑', '', '한솔'], // 사람 칸이 하나면 인터뷰자
            ['박다솜', 'O', null, '', '한솔'], // '-' 는 빈 칸
            ['최미르', '보류', '노원', '문별', '한솔'],
            ['정보라', 'X', null, '주서영', '한솔'], // 지역 없이 바로 인도자
            ['홍새봄', 'X', '성북', '', '한솔'],
        ]
    );
    assert.equal(xs[0].phone, '010-1111-2222');
    assert.equal(xs[3].phone, '010-3333-4444');
    assert.equal(xs[1].birthDate, '20030718');
    assert.match(xs[1].memo, /목,금 오후 가능\/생년월일: 20030718\n본가 지방/);
    assert.match(xs[3].memo, /t\.me/);
    assert.deepEqual(parseInterviewSheet('오늘 #회의/공지 없음'), []); // '#'로 시작하는 줄만
});

test('"#" 없이 쓴 당일 인터뷰 양식 — 후속연결 제목 아래 "이름/…" 줄, 새신자·대학 같은 지역 칸, 빈 줄로 구분', () => {
    const sheet = `📌 당일 인터뷰 양식
구분 : 당터뷰
날짜 : 9/12
✔️ 탕터뷰 후 바로 누적
섭외자/지역/인도자/인터뷰자/다음 만남예정일, 장소/간단정보


▪️후속연결O
가나다/새신자/라마바/사아자/일요일만 가능;;/22살 대학원생. 2,3번 낮음.

차카타/성북/파하가/나다라/토요일O, 평일하루/ 20세, 번호 받음

▪️후속연결 보류
마바사/대학/아자차/사아자/대학교 이름은 말하지 않음.

▪️후속연결 X
카타파/새신자/하가나/라마바/경희대 1학년. 연락처 거절`;
    assert.equal(sheetKind(sheet), '당터뷰');
    assert.deepEqual(
        parseInterviewSheet(sheet).map((x) => [x.name, x.followUp, x.region, x.guides.join(','), x.interviewer]),
        [
            ['가나다', 'O', '새신자', '라마바', '사아자'],
            ['차카타', 'O', '성북', '파하가', '나다라'],
            ['마바사', '보류', '대학', '아자차', '사아자'],
            ['카타파', 'X', '새신자', '하가나', '라마바'],
        ]
    );
    assert.match(parseInterviewSheet(sheet)[0].memo, /^일요일만 가능;;\/22살 대학원생/);
});

test('새 양식 — 섭외자/성별/연락처/지역/인도자/인터뷰자/다음 만남/간단정보 (예전 양식과 섞여도)', () => {
    const xs = parseInterviewSheet(`섭외자/성별/연락처/지역/인도자/인터뷰자/다음 만남예정일, 장소/간단정보
▪️후속연결O
#이가온/남/010-1234-0001/성북/양하늘/손바람/10.30(금),노원/07.10.12, 1학년
나봄이/여자/5678/강북/이채윤, 박용화/한솔/평일 월/20살
▪️후속연결 X
#다솜/-/0000/?/-/황금새/-/관심 없음
#김가람/성북/양하늘/한솔/추후연락
#라온/-/-/노원/문별/한솔/-/연락처 거절`);
    assert.deepEqual(
        xs.map((x) => [x.name, x.gender, x.phone, x.region, x.guides.join(','), x.interviewer]),
        [
            ['이가온', '남', '010-1234-0001', '성북', '양하늘', '손바람'],
            ['나봄이', '여', '5678', '강북', '이채윤,박용화', '한솔'], // 뒷자리만 써도 그대로
            ['다솜', null, '0000', null, '', '황금새'], // '-'·'?' 는 빈 칸
            ['김가람', null, null, '성북', '양하늘', '한솔'], // 예전 양식 줄
            ['라온', null, null, '노원', '문별', '한솔'], // 성별·연락처 둘 다 비워도 7칸 이상이면 새 양식
        ]
    );
    assert.match(xs[0].memo, /^10\.30\(금\),노원\/07\.10\.12/); // 다음 만남부터 메모 (특전대 2차 만남으로 씀)
    const [dig] = interviewToForms({ ...xs[1], follow_up: 'O', birth_date: null }, undefined, 2026);
    assert.equal(dig.values.gender, '여');
});

test('구분 — 제목에 향수면 향수행사 (안내문의 "당터뷰" 단어는 무시), 아니면 당터뷰, "구분:" 줄 우선', () => {
    assert.equal(sheetKind(SHEET), '향수행사'); // 향수 양식 안에 '당터뷰어 필독'이 있어도
    assert.equal(sheetKind('📌 당터뷰 결과\n▪️후속연결O\n#김하나/성북/한솔/향수 좋아함'), '당터뷰'); // 메모 속 '향수'는 무시
    assert.equal(sheetKind('#김하나/성북/한솔'), '당터뷰');
    assert.equal(sheetKind('📌 당일 인터뷰 양식\n✔️ 향수행사 참석자는 따로\n#김하나/성북/한솔'), '당터뷰'); // 당일 양식 안내에 '향수'가 있어도
    assert.equal(sheetKind('구분: 향수행사\n#김하나/성북/한솔'), '향수행사');
    assert.equal(sheetKind('📌 향수 인터뷰 양식\n구분: 당터뷰\n#김하나/성북/한솔'), '당터뷰');
});

// 텔레그램 API 가로채기
let calls: { method: string; payload: any }[] = [];
(Telegram.prototype as any).callApi = async function (method: string, payload: any) {
    calls.push({ method, payload });
    if (method === 'answerCallbackQuery') return true;
    return { message_id: calls.length, date: 0, chat: { id: payload.chat_id, type: 'private' }, text: payload.text };
};
const bot = new Telegraf('1:TEST');
bot.botInfo = { id: 1, is_bot: true, first_name: 'sida', username: 'sidabot' } as any;
registerCore(bot);
registerSida(bot); // 특전대와 같이 돌 때 서로 간섭하지 않는지
registerInterview(bot);
let n = 0;
async function send(from: number, text: string, chatId = from) {
    calls = [];
    await bot.handleUpdate({
        update_id: ++n,
        message: { message_id: 5000 + n, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: chatId < 0 ? 'supergroup' : 'private' }, from: { id: from, is_bot: false, first_name: `U${from}` }, text },
    } as any);
    return calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text).join('\n---\n');
}

const labelsOf = (_: string) => calls.flatMap((c) => c.payload?.reply_markup?.inline_keyboard?.flat().map((b: any) => b.text) ?? []);

before(async () => {
    setQueryable(pgliteQueryable(new PGlite()));
    await runMigrations();
    // 카운셀링 봇 행정 DB 흉내 (실제 컬럼 이름 그대로)
    await query(`
        CREATE TABLE members ("고유번호" TEXT PRIMARY KEY, "이름" TEXT, "지역" TEXT, "구역" TEXT);
        CREATE TABLE students (id SERIAL PRIMARY KEY, "이름" TEXT, "단계" TEXT, "인도자_고유번호" TEXT, "교사_고유번호" TEXT, "탈락" DATE, "찾_완료일" DATE, "합_완료일" DATE);
        INSERT INTO members VALUES ('M1', '양하늘', '성북', '1-1'), ('M2', '최바다', '중랑구', '2-1'), ('M3', '문별', '노원', '3-1'), ('M4', '주서영', '성북', '1-2');
        INSERT INTO students ("이름", "단계", "인도자_고유번호", "탈락") VALUES
            ('김가람', '찾', 'M1', NULL), ('이나래', '합', 'M2', NULL),
            ('박다솜', '발', 'M1', NULL), ('박다솜', '발', 'M3', NULL),
            ('정보라', '발', 'M4', '2026-10-01');
    `);
});

test('등록 안 된 방에서는 저장 안 함 → 방등록 후 저장, 다시 올리면 덮어씀', async () => {
    assert.doesNotMatch(await send(201, SHEET, GROUP), /저장/);
    assert.match(await send(201, '/인터뷰 방등록', GROUP), /권한이 없습니다/);
    assert.match(await send(ADMIN, '/인터뷰 방등록', GROUP), /인터뷰 결과 방으로 등록/);
    const out = await send(201, SHEET, GROUP);
    assert.match(out, /\[향수행사\] 인터뷰 결과 6명 저장 \(새로 6 · 수정 0\)/);
    assert.match(out, /O 3 · 보류 1 · X 2/);
    // 확인 필요: 인도자 없음(이나래·박다솜), 행정에서 못 찾음(최미르), 동명이인(박다솜) — 후속 X(정보라·홍새봄)는 제외
    assert.match(out, /확인 필요<\/b> \(후속 X 제외\)\n• 인도자 없음: 이나래, 박다솜\n• 행정에서 못 찾음: 최미르\n• 행정에 같은 이름 여러 명: 박다솜/);
    assert.doesNotMatch(out, /홍새봄|정보라/);
    assert.match(await send(201, SHEET, GROUP), /새로 0 · 수정 6/);
    assert.equal((await query(`SELECT count(*)::int AS n FROM cdabot_interviews`)).rows[0].n, 6);
});

test('행정 연결 — 이름+인도자, 인도자 없으면 지역, 동명이인은 연결 안 함', async () => {
    const rows = (await query(`SELECT name, student_id, match_note FROM cdabot_interviews ORDER BY id`)).rows;
    const by = Object.fromEntries(rows.map((r) => [r.name, r.student_id ? 'linked' : r.match_note]));
    assert.deepEqual(by, { 김가람: 'linked', 이나래: 'linked', 박다솜: 'multi', 최미르: 'none', 정보라: 'linked', 홍새봄: 'none' });
});

test('관리자 현황·미등록·검색, 나중에 행정 등록되면 미등록에서 빠짐', async () => {
    const r = await send(ADMIN, '/인터뷰 현황');
    assert.match(r, /인터뷰 <b>6명<\/b> — 후속연결 O 3 · 보류 1 · X 2/);
    assert.match(r, /행정 등록 <b>3명<\/b> \(50%\) — 찾 1 · 합 1 · 탈락 1/);
    assert.match(r, /행정 미등록 \(후속 X 제외\) 2명 · 동명이인 확인 필요 1명/);
    assert.match(r, /한솔: 6명 · 후속O 3 · 행정 3/);

    let u = await send(ADMIN, '/인터뷰 미등록');
    assert.match(u, /박다솜.*같은 이름 여러 명/);
    assert.match(u, /최미르/);
    assert.doesNotMatch(u, /홍새봄|김가람/); // 후속 X·이미 등록은 제외

    await query(`INSERT INTO students ("이름", "단계", "인도자_고유번호") VALUES ('최미르', '발', 'M3')`);
    u = await send(ADMIN, '/인터뷰 미등록');
    assert.doesNotMatch(u, /최미르/);

    const s = await send(ADMIN, '/인터뷰 검색 김가람');
    assert.match(s, /010-1111-2222/);
    assert.match(s, /행정: <b>찾<\/b>/);
});

test('행정 DB를 못 읽어도 인터뷰 현황은 보임', async () => {
    await query(`ALTER TABLE students RENAME TO students_x`);
    try {
        const r = await send(ADMIN, '/인터뷰 현황');
        assert.match(r, /인터뷰 <b>6명/);
        assert.match(r, /행정 DB\(students\)를 읽지 못해/);
    } finally {
        await query(`ALTER TABLE students_x RENAME TO students`);
    }
});

test('권한 — 올리기만 하는 사람·특전대 관리자는 추적 화면 불가, 관리자도 명단은 개인정보 권한 필요', async () => {
    for (const cmd of ['현황', '미등록', '검색 김가람', '권한 301 manager']) assert.match(await send(201, `/인터뷰 ${cmd}`), /권한이 없습니다/, cmd);
    assert.match(await send(777, '/인터뷰 현황'), /권한이 없습니다/); // 처음 보는 사람
    assert.match(await send(ADMIN, '/인터뷰 권한 301 manager 관리자박'), /관리자박: 관리자/);
    assert.match(await send(301, '/인터뷰 현황'), /인터뷰 <b>6명/);
    assert.match(await send(301, '/인터뷰 미등록'), /권한이 없습니다/);
    assert.match(await send(301, '/인터뷰 현황', GROUP), /1:1 대화에서/); // 단체방에 현황 노출 안 함
    assert.match(await send(301, '/특전대 시간표'), /등록되어 있지 않습니다/); // 특전대 권한과 별개
});

test('/인터뷰 단계 — 기본 전체 기간에서 찾등·합등 (완료일 또는 현재 단계), 기간을 적으면 완료일 기준', async () => {
    assert.match(await send(301, '/인터뷰 단계'), /권한이 없습니다/); // 관리자여도 개인정보 권한 필요
    assert.match(await send(ADMIN, '/인터뷰 권한 302 manager,pii 관리자최'), /관리자최/);
    // 완료일이 아직 없어도 현재 단계로: 김가람 찾 → 찾등, 이나래 합 → 합등 (찾등 명단엔 다시 안 나옴)
    let out = await send(302, '/인터뷰 단계');
    assert.match(out, /전체 기간/);
    assert.match(out, /행정 연결 4명 중 찾등 <b>2명<\/b> · 합등 <b>1명<\/b>/);
    assert.match(out, /\[합등 1명\]<\/b>\n• 날짜 없음 <b>이나래<\/b> \[향수행사\] 현재 합/);
    assert.match(out, /\[찾등 \(합등 전\) 1명\]<\/b>\n• 날짜 없음 <b>김가람<\/b>/);
    assert.equal(calls.filter((c) => c.method === 'sendMessage').length, 1); // 요청한 사람에게만

    await query(`UPDATE students SET "찾_완료일" = '2026-10-05', "합_완료일" = '2026-10-21' WHERE "이름" = '김가람'`);
    await query(`UPDATE students SET "찾_완료일" = '2026-10-22' WHERE "이름" = '이나래'`);
    await query(`UPDATE students SET "찾_완료일" = '2026-09-01' WHERE "이름" = '정보라'`); // 오래전 찾등, 지금 탈락
    out = await send(302, '/인터뷰 단계');
    assert.match(out, /찾등 <b>3명<\/b> · 합등 <b>2명<\/b>/);
    assert.match(out, /\[합등 2명\]<\/b>\n• 10\/21 <b>김가람<\/b> \[향수행사\] 현재 찾 <i>\(인터뷰 \d+\/\d+ · 성북 · 인도 양하늘,강구름 · 인터뷰 한솔\)<\/i>\n• 날짜 없음 <b>이나래<\/b>/);
    assert.match(out, /\[찾등 \(합등 전\) 1명\]<\/b>\n• 9\/1 <b>정보라<\/b> \[향수행사\] 현재 탈락/);
    assert.match(out, /한솔: 찾등 3 · 합등 2/);
    assert.doesNotMatch(out, /최미르/); // 발 단계

    out = await send(302, '/인터뷰 단계 2026.10.20~2026.10.25'); // 기간을 적으면 그 기간 완료일만
    assert.match(out, /10\/20~10\/25/);
    assert.match(out, /찾등 <b>1명<\/b> · 합등 <b>1명<\/b>/);
    assert.match(out, /\[합등 1명\]<\/b>\n• 10\/21 <b>김가람<\/b>/);
    assert.match(out, /\[찾등 \(합등 전\) 1명\]<\/b>\n• 10\/22 <b>이나래<\/b>/);
    assert.doesNotMatch(out, /정보라/);
});

test('/인터뷰 행정 — 행정 등록자를 현재 단계별로 (높은 단계부터, 탈락은 맨 아래)', async () => {
    assert.match(await send(301, '/인터뷰 행정'), /권한이 없습니다/); // 개인정보 권한 필요
    const out = await send(302, '/인터뷰 행정');
    assert.match(out, /행정 등록자 상태<\/b> 전체 기간/);
    assert.match(out, /행정 등록 <b>4명<\/b> — 발 1 · 찾 1 · 합 1 · 탈락 1/);
    assert.match(out, /\[합 1명\]<\/b>\n• <b>이나래<\/b>[\s\S]*\[찾 1명\]<\/b>\n• <b>김가람<\/b> \[향수행사\] <i>\(인터뷰 \d+\/\d+ · 성북[\s\S]*\[발 1명\]<\/b>\n• <b>최미르<\/b>[\s\S]*\[탈락 1명\]<\/b>\n• <b>정보라<\/b>/);
    assert.doesNotMatch(out, /박다솜|홍새봄/); // 행정 미연결은 제외
    assert.match(await send(302, '/인터뷰 행정 당터뷰'), /행정에 등록된 인터뷰 대상자가 없습니다/);
    assert.ok(labelsOf(await send(302, '/인터뷰 현황')).includes('📋 행정 등록자 상태'));
});

test('밀린 결과 — 1:1로 "날짜:" 줄과 함께 보내면 그 날짜로 저장, 미래·권한 없음은 저장 안 함', async () => {
    const back = '날짜: 2026.10.20\n▪️후속연결O\n#윤하람/성북/양하늘/한솔/메모';
    assert.doesNotMatch(await send(777, back), /저장/); // 인터뷰 권한 없는 사람
    assert.match(await send(ADMIN, back), /10\/20 \[당터뷰\] 인터뷰 결과 1명 저장 \(새로 1 · 수정 0\)/);
    assert.equal((await query(`SELECT interview_date::text AS d FROM cdabot_interviews WHERE name = '윤하람'`)).rows[0].d, '2026-10-20');
    assert.match(await send(ADMIN, back), /새로 0 · 수정 1/); // 다시 보내면 덮어씀
    assert.match(await send(ADMIN, '날짜: 2099.1.1\n#윤하람/성북/양하늘/한솔'), /날짜를 확인해주세요[\s\S]*저장하지 않았습니다/);
    assert.match(await send(ADMIN, '날짜: 언젠가\n#윤하람/성북/양하늘/한솔'), /날짜를 확인해주세요/);
    assert.match(await send(302, '#서다온/노원/문별/한솔'), /\(오늘\) \[당터뷰\] 인터뷰 결과 1명 저장[\s\S]*날짜: 10\.20/); // 날짜 없으면 오늘 + 안내
});

test('구분별로 나눠 보기 — 현황·미등록·찾등합등에 향수/당터뷰를 붙이면 그 구분만', async () => {
    // 지금까지: 향수행사 6명(SHEET) + 당터뷰 2명(윤하람 10/20, 서다온 오늘)
    let r = await send(ADMIN, '/인터뷰 현황 2026.10.1~2026.12.31');
    assert.match(r, /\[구분별\]<\/b>\n• 향수행사: 6명[^\n]*\n• 당터뷰: 2명/);
    r = await send(ADMIN, '/인터뷰 현황 당터뷰 2026.10.1~2026.12.31');
    assert.match(r, /인터뷰·행정 현황 \[당터뷰\]<\/b>[\s\S]*인터뷰 <b>2명<\/b>/);
    assert.doesNotMatch(r, /\[구분별\]/);
    r = await send(ADMIN, '/인터뷰 미등록 향수 2026.10.1~2026.12.31');
    assert.match(r, /행정 미등록 \[향수행사\]/);
    assert.match(r, /박다솜<\/b> \[향수행사\]/);
    assert.doesNotMatch(r, /서다온|윤하람/);
    r = await send(ADMIN, '/인터뷰 단계 당터뷰 2026.10.20~2026.10.25');
    assert.match(r, /찾등·합등 \[당터뷰\]/);
    assert.match(r, /없습니다/); // 찾·합한 사람은 모두 향수행사
    r = await send(ADMIN, '/인터뷰 단계 2026.10.20~2026.10.25');
    assert.match(r, /\[구분별\]<\/b>\n• 향수행사: 찾등 1 · 합등 1/);
});

test('삭제 — 올린 본인·관리자만, 날짜+이름으로', async () => {
    assert.match(await send(201, '/인터뷰 삭제 윤하람'), /사용법/);
    assert.match(await send(777, '/인터뷰 삭제 2026.10.20 윤하람'), /권한이 없습니다/);
    assert.match(await send(201, '/인터뷰 삭제 2026.10.20 윤하람'), /본인이 올린 결과만/); // ADMIN 이 올린 것
    await send(201, '▪️후속연결O\n#홍새봄봄/성북/양하늘/한솔/오타', GROUP);
    assert.match(await send(201, '/인터뷰 삭제 오늘 홍새봄봄', GROUP), /\[당터뷰\] 홍새봄봄 인터뷰 기록을 삭제/);
    assert.match(await send(ADMIN, '/인터뷰 삭제 2026.10.20 윤하람'), /삭제했습니다/); // 관리자는 남의 것도
    assert.match(await send(ADMIN, '/인터뷰 삭제 2026.10.20 윤하람'), /기록이 없습니다/);
    assert.equal((await query(`SELECT count(*)::int AS n FROM cdabot_interviews WHERE name IN ('윤하람', '홍새봄봄')`)).rows[0].n, 0);
});

test('특전대 양식으로 바꾸기 — 모두 발굴, 후속 O 는 찾기도, 메모에서 생년·성별·2차 만남', () => {
    const [o, x] = parseInterviewSheet(`▪️후속연결O
#이가온/성북/양하늘/손바람/10.30(금) 시간대 상관없음,노원/자율전공 1학년, 010-1234-0001
07.10.12 인터뷰 체크함
▪️후속연결 X
#김건모/?/?/황금새/남 intp 22살, 여자친구 주려고 옴`);
    const toRow = (e: typeof o) => ({ ...e, follow_up: e.followUp, birth_date: e.birthDate, kind: '향수행사' as const });
    const forms = interviewToForms(toRow(o), { region: '성북구', team: '1-1' }, 2026);
    assert.deepEqual(forms.map((f) => f.kind), ['dig', 'find']);
    assert.deepEqual(forms[0].values, {
        name: '이가온', region: '성북구', team: '1-1', guide: '양하늘', phone: '0001', // 뒷자리만
        age_group: '20대 초', tool: '당터뷰', meet_at: '10.30(금) 시간대 상관없음', meet_place: '노원',
    });
    assert.deepEqual(forms[1].values, { name: '이가온', region: '성북구', team: '1-1', guide: '양하늘', birth_date: '071012' });
    const xf = interviewToForms(toRow(x), undefined, 2026);
    assert.deepEqual(xf.map((f) => f.kind), ['dig']); // 후속 X 는 발굴만, 2차 만남 없음(답장 안온)
    assert.deepEqual(xf[0].values, { name: '김건모', age_group: '20대 초', gender: '남', tool: '당터뷰' }); // '?' 지역은 빈 칸
    assert.equal(birth6(null, '05년생3.9생일, 010-2222-3333'), '050309');
    assert.equal(birth6(null, '10.30 노원'), null);
    assert.equal(ageGroup('24살 남성', null, 2026), '20대 중');
    assert.equal(ageGroup('19살', null, 2026), null);
    assert.equal(genderOf('3년 사귄 여자친구'), null);
    assert.equal(meetOf('ISFP, 바둑기사/010'), null);
    assert.deepEqual(meetOf('평일12시전,노원거주/20살'), { at: '평일12시전', place: '노원거주' });
});

test('/인터뷰 특전대 — 미리보기 → 등록, 인도자와 같은 이름 대원 실적, 두 번 등록 안 됨', async () => {
    const u = await upsertUser(4242, '양하늘');
    await upsertMembership(1, u.id, 'sida', '양하늘', 'active');
    const sheet = `날짜: 2026.10.2\n구분: 향수행사\n▪️후속연결O\n#이가온/성북/양하늘/손바람/10.30(금),노원/07.10.12, 010-1234-0001\n▪️후속연결X\n#김건모/노원/문별/황금새/남 22살`;
    await send(ADMIN, sheet);
    assert.ok(!labelsOf('').includes('🪖 특전대 결과로 등록')); // 특전대 주차가 없으면 버튼 없음
    assert.match(await send(ADMIN, '/인터뷰 특전대 2026.10.2'), /특전대 기간\(주차\)이 아닌/);
    await createPeriod(1, '2026-09-28'); // 10.2(금)가 든 주차
    const saved = await send(ADMIN, sheet);
    assert.ok(labelsOf('').includes('🪖 특전대 결과로 등록'));
    const btnData = calls.flatMap((c) => c.payload?.reply_markup?.inline_keyboard?.flat() ?? []).find((b: any) => b.text.startsWith('🪖')).callback_data;
    assert.match(saved, /2명 저장/);
    const press = async (data: string) => {
        calls = [];
        await bot.handleUpdate({ update_id: ++n, callback_query: { id: String(n), from: { id: ADMIN, is_bot: false, first_name: 'A' }, chat_instance: 'x', data, message: { message_id: 1, date: 0, chat: { id: ADMIN, type: 'private' }, text: '.' } } } as any);
        return calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text).join('\n---\n');
    };
    const pv = await press(btnData);
    assert.match(pv, /발굴 1건 · 찾기 1건/);
    assert.match(pv, /발\/이가온\/0001\/20대 초\/\/성북\/1\/양하늘\/당터뷰\/\+10\.30\(금\),노원\n  → 대원 양하늘/); // 행정 members 의 인도자 지역, 팀은 구역 '1-1' 의 앞자리
    assert.match(pv, /찾\/이가온\/071012\/성북\/1\/양하늘 *\n/);
    assert.match(pv, /제외 1명: 김건모\(문별\)/); // 인도자 이름의 대원이 없으면 등록 안 함
    const okData = calls.flatMap((c) => c.payload?.reply_markup?.inline_keyboard?.flat() ?? []).find((b: any) => b.text.startsWith('✅')).callback_data;
    assert.match(await press(okData), /특전대 결과 2건 등록/);
    const rs = (await query(`SELECT r.kind, r.name, r.meet_at, u.telegram_id::text AS tg FROM cdabot_results r JOIN cdabot_users u ON u.id = r.user_id WHERE r.activity_date = '2026-10-02' ORDER BY r.name DESC, r.kind`)).rows;
    assert.deepEqual(rs.map((r) => [r.kind, r.name, r.meet_at, r.tg]), [
        ['dig', '이가온', '10.30(금)', '4242'],
        ['find', '이가온', null, '4242'],
    ]);
    assert.match(await press(okData), /0건 등록/); // 다시 눌러도 안 늘어남
    assert.match(await press(btnData), /등록할 사람이 없습니다. \(이미 등록 2건\)[\s\S]*김건모/);
});

test('보관기간 지나면 이름·연락처·메모 삭제, 건수는 유지', async () => {
    await setSetting(1, MODULE_KEY, 'pii_retention_days', 30);
    await query(`UPDATE cdabot_interviews SET interview_date = CURRENT_DATE - 31 WHERE name = '김가람'`);
    assert.equal(await purgeExpiredInterviews(), 1);
    const row = (await query(`SELECT name, phone, memo, student_id FROM cdabot_interviews WHERE pii_purged_at IS NOT NULL`)).rows[0];
    assert.deepEqual([row.name, row.phone, row.memo], [null, null, null]);
    assert.ok(row.student_id, '행정 연결은 유지');
});
