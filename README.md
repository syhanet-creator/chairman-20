# chairman-20

정이석 회장 개인용 문자발송 시스템 (주민협의회 회원 약 3,000명 대상)

- 발신번호: 010-8507-5035 (솔라피에 본인인증 사전등록 필요)
- 프론트: 단일 HTML PWA (`public/`)
- 백엔드: Vercel Serverless (`api/`), DB는 Supabase `khnlu-accounting` 프로젝트의 `jsms_` 접두어 테이블
- 발송 공급자: 기본 `console`(연습모드) → 솔라피 키 설정 후 설정 화면에서 `solapi`로 전환

## Supabase 테이블 (jsms_ 접두어, 기존 테이블과 분리)

`jsms_settings`, `jsms_contacts`, `jsms_templates`, `jsms_messages`, `jsms_message_recipients`, `jsms_audit`
RLS 활성화(정책 없음) — 서버의 service role 키로만 접근합니다.

## Vercel 환경변수

| 이름 | 설명 |
|---|---|
| `SUPABASE_URL` | https://helgojjololdjgugwwvr.supabase.co |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role 키 (서버 전용, 절대 노출 금지) |
| `APP_PASSWORD` | 앱 로그인 비밀번호 |
| `SESSION_SECRET` | 로그인 토큰 서명용 임의의 긴 문자열 |
| `SOLAPI_API_KEY` | (추후) 솔라피 API Key |
| `SOLAPI_API_SECRET` | (추후) 솔라피 API Secret |

## 솔라피 연동 시

1. 솔라피에서 발신번호 010-8507-5035 등록(휴대폰 본인인증)
2. Vercel에 `SOLAPI_API_KEY`, `SOLAPI_API_SECRET` 설정 후 재배포
3. 앱 설정 → 발송 모드를 「실발송(솔라피)」로 변경
4. 소량(본인 번호 1~2건)으로 먼저 테스트
   - 응답 필드 매핑(`api/_provider.js`)은 연동 테스트 시 한 번 확인 필요

## 광고성 문자

「광고성 문자」 체크 시 `(광고)단체명` 표기와 수신거부 문구가 자동 삽입됩니다. 수신거부 080 번호는 설정에서 실제 번호로 바꿔야 하며, 오후 9시~오전 8시 발송은 법으로 제한됩니다.
