-- ============================================================
-- 호두로그 — 사라진 기록 복구용 SQL (1회 실행)
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 Run 누르면 끝입니다.
--
-- [원인]
-- 이 앱은 "익명 로그인"을 쓰는데, 그 로그인 정보(uid)가 브라우저
-- 저장소(localStorage)에만 저장됩니다. 그런데 그동안 캐시 문제를
-- 해결하려고 "사이트 데이터 지우기"를 여러 번 안내드렸는데, 그때마다
-- 이 uid가 초기화되면서 완전히 새로운 익명 사용자가 됐습니다.
-- 기존 records 테이블의 RLS 정책이 "내 uid로 만든 기록만 보이게"
-- 되어 있다 보니, 예전 uid로 저장된 기록/사진들이 실제로 삭제된 게
-- 아니라 "지금 uid와 안 맞아서 안 보이는" 상태가 된 것입니다.
-- (데이터 자체는 테이블/Storage에 그대로 남아 있습니다.)
--
-- [조치]
-- 이 앱은 어차피 한 분만 쓰는 개인용 앱이라, uid로 데이터를 나눌
-- 필요가 없습니다. 그래서 "내 uid만" 제한을 없애고, 이 앱에 접속한
-- 익명 세션이면 전체 기록을 항상 보고 관리할 수 있도록 정책을
-- 완화합니다. 이렇게 하면 앞으로 캐시/사이트 데이터를 지워도
-- 다시는 기록이 안 보이는 일이 없습니다.
-- ============================================================

-- 1) records 테이블: uid 제한 없이 전체 기록을 조회/등록/수정/삭제 가능하도록 완화
drop policy if exists "select_own_records" on public.records;
create policy "select_all_records"
  on public.records for select
  to authenticated
  using (true);

drop policy if exists "insert_own_records" on public.records;
create policy "insert_any_records"
  on public.records for insert
  to authenticated
  with check (true);

drop policy if exists "update_own_records" on public.records;
create policy "update_any_records"
  on public.records for update
  to authenticated
  using (true)
  with check (true);

drop policy if exists "delete_own_records" on public.records;
create policy "delete_any_records"
  on public.records for delete
  to authenticated
  using (true);

-- 2) Storage(사진): 마찬가지로 업로드한 사람의 uid 폴더가 달라도
--    이 앱 세션이면 전체 사진을 보고/삭제할 수 있도록 완화
drop policy if exists "own_folder_insert_hodulog_photos" on storage.objects;
create policy "any_folder_insert_hodulog_photos"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'hodulog-photos');

drop policy if exists "own_folder_delete_hodulog_photos" on storage.objects;
create policy "any_folder_delete_hodulog_photos"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'hodulog-photos');

-- (public_read_hodulog_photos 정책은 이미 전체 공개 조회라 그대로 둡니다)

-- ============================================================
-- 실행 후 확인 방법:
-- 1. 왼쪽 메뉴 Table Editor > records 테이블을 열어서
--    예전에 등록했던 기록 행들이 실제로 남아있는지 눈으로 확인하세요.
--    (user_id 컬럼 값이 서로 다른 여러 종류로 보일 수 있는데 정상입니다.)
-- 2. 앱을 새로고침하면 그 기록들이 모두 화면에 다시 나타나야 합니다.
-- ============================================================
