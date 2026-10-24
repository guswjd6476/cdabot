// 실행: npm test
import assert from 'node:assert/strict';
import { parseReportNumbers } from './utils';

assert.deepEqual(parseReportNumbers('[특전대 결과]\n• 전도: 3명\n- 섭외 : 1\n1. 열매：2건'), { 전도: 3, 섭외: 1, 열매: 2 });
assert.deepEqual(parseReportNumbers('시간: 19:00\n날짜: 10.8\n이름: 홍길동'), {});
assert.deepEqual(parseReportNumbers('전도: 2\n전도: 1'), { 전도: 3 });
console.log('✅ utils 테스트 통과');
