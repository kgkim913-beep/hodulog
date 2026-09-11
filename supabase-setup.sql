-- ============================================================
-- 호두로그 MVP — Supabase 설정 SQL
-- Supabase 대시보드 > SQL Editor 에 이 파일 내용을 그대로 붙여넣고
-- 실행하세요 (Run 버튼 한 번으로 테이블 + RLS + Storage까지 전부 생성됩니다).
-- ============================================================

-- ------------------------------------------------------------
-- 1) records 테이블
-- ------------------------------------------------------------
create table if not exists public.records (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid not null default auth.uid(),   -- 이 기록을 만든 사용자 (익명 로그인 uid)

  place_name text not null,                    -- 장소명
  trip_name text,                               -- 여행 이름 (선택)
  companion text,                               -- 함께한 사람

  ratings jsonb not null default
    '{"taste":4,"warm":70,"red":4,"walnut":3,"texture":4}'::jsonb,
  -- ratings.taste   = 종합맛 (1~5)
  -- ratings.warm    = 따뜻함 (0~100, 슬라이더)
  -- ratings.red     = 팥 만족도 (1~5)
  -- ratings.walnut  = 호두 존재감 (1~5)
  -- ratings.texture = 식감 (1~5)
  final_score int not null default 0,           -- 100점 만점 최종 점수

  tags text[] not null default '{}',
  memo text,                                    -- 한줄평

  gps_lat double precision,                     -- GPS 위도 (권한 거부 시 null)
  gps_lng double precision,                     -- GPS 경도
  gps_accuracy double precision,                -- GPS 오차 반경(m)

  photo_urls text[] not null default '{}'       -- Storage 공개 URL 목록 (등록 순서 유지)
);

comment on table public.records is '호두로그 MVP — 기록 1건 = 1행';

-- 이미 예전 버전으로 테이블을 만들어두신 경우를 위한 안전한 컬럼 추가(있으면 무시)
alter table public.records add column if not exists user_id uuid not null default auth.uid();
alter table public.records add column if not exists gps_lat double precision;
alter table public.records add column if not exists gps_lng double precision;
alter table public.records add column if not exists gps_accuracy double precision;

create index if not exists records_user_id_idx on public.records (user_id);
create index if not exists records_created_at_idx on public.records (created_at desc);

-- ------------------------------------------------------------
-- 2) Row Level Security — "로그인한 사용자는 자기 데이터만" 적용
-- ------------------------------------------------------------
alter table public.records enable row level security;

drop policy if exists "select_own_records" on public.records;
create policy "select_own_records"
  on public.records for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "insert_own_records" on public.records;
create policy "insert_own_records"
  on public.records for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "update_own_records" on public.records;
create policy "update_own_records"
  on public.records for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "delete_own_records" on public.records;
create policy "delete_own_records"
  on public.records for delete
  to authenticated
  using (auth.uid() = user_id);

-- ------------------------------------------------------------
-- 3) Storage: 사진 저장용 버킷 (비공개 업로드, 공개 조회)
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('hodulog-photos', 'hodulog-photos', true)
on conflict (id) do nothing;

-- 이 앱은 파일을 "{내 uid}/파일명" 경로로 업로드합니다.
-- 그래서 경로의 첫 폴더명(=user_id)이 본인 uid와 같을 때만 쓰기/삭제를 허용합니다.

drop policy if exists "public_read_hodulog_photos" on storage.objects;
create policy "public_read_hodulog_photos"
  on storage.objects for select
  to public
  using (bucket_id = 'hodulog-photos');

drop policy if exists "own_folder_insert_hodulog_photos" on storage.objects;
create policy "own_folder_insert_hodulog_photos"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'hodulog-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "own_folder_delete_hodulog_photos" on storage.objects;
create policy "own_folder_delete_hodulog_photos"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'hodulog-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ============================================================
-- 참고: 이 SQL만 실행해서는 로그인이 되지 않습니다.
-- Supabase 대시보드에서 아래를 반드시 켜주세요 (SQL 아님, 화면에서 클릭):
--   Authentication → Sign In / Providers → Anonymous Sign-Ins → Enable
-- 이 앱은 사용자에게 별도 회원가입/로그인 화면 없이,
-- 기기에서 처음 열 때 자동으로 "익명 로그인"을 하고, 그 익명 계정의
-- auth.uid() 기준으로 본인 기록만 보이고 수정/삭제할 수 있게 됩니다.
-- ============================================================
