# 호두로그 — 설치형 MVP

기존 hodulog-kelly 디자인/HTML/CSS/JS 구조를 그대로 유지하면서, 실제 Supabase 연동·카메라·GPS·오프라인 임시저장 기능을 추가한 버전입니다.

## 실행 순서
1. `supabase-setup.sql`을 Supabase 대시보드 SQL Editor에서 실행
2. Supabase 대시보드에서 **Authentication → Providers → Anonymous Sign-Ins** 활성화
3. `config.js`에 `SUPABASE_URL`, `SUPABASE_ANON_KEY` 입력
4. 이 폴더 전체를 HTTPS로 호스팅 (Vercel / Netlify / GitHub Pages 등 아무거나) — **PWA 설치와 카메라 기능 모두 HTTPS 필수**
5. 아이폰 Safari로 배포 주소 접속 → 홈 화면에 추가

## 파일 구성
- `index.html` — 기존 화면 그대로 + PWA 메타태그 + 실기기 전체화면 대응
- `app.js` — 실제 기능 로직 (카메라/GPS/Supabase CRUD/오프라인 임시저장)
- `config.js` — Supabase 키 입력 (본인이 채워야 함)
- `manifest.webmanifest`, `sw.js`, `icons/`, `apple-touch-icon.png` — PWA 설치 관련
- `supabase-setup.sql` — DB 테이블 + RLS + Storage 버킷 설정

자세한 안내는 대화창의 최종 요약을 참고하세요.
