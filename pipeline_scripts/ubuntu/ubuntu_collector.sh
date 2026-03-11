#!/bin/bash
set -e

DATA_DIR="./ubuntu_data"
REPO_DIR="ubuntu-security-notices"
REPO_URL="https://github.com/canonical/ubuntu-security-notices.git"

echo "=== Ubuntu LTS USN 수집 시작 (22.04 + 24.04 only, 90일) ==="
echo "90일 전 기준: $(date -d '90 days ago' +%Y-%m-%d)"
echo "데이터 저장 위치: $DATA_DIR"
echo "Incremental 모드 활성화 (이미 존재하면 skip)"

# 1. 매번 완전 신규 클론
echo "기존 repo 삭제 후 최신 클론 중..."
echo rm -rf "$REPO_DIR"
echo git clone --depth 1 "$REPO_URL" "$REPO_DIR"

cd "$REPO_DIR"

DAYS_AGO=$(date -d '90 days ago' +%Y-%m-%d)

echo "=== 패치 추출 및 변환 시작 ==="

find osv/usn -name "USN-*.json" | sort | while read -r file; do
  ID=$(jq -r '.id // empty' "$file" 2>/dev/null)

  if [ -z "$ID" ]; then
    continue
  fi

  # === Incremental Skip ===
  if [ -f "../$DATA_DIR/${ID}.json" ]; then
    echo "⏭️ Skip (이미 존재): $ID"
    continue
  fi

  # Red Hat 스타일 JSON 생성 (packages 개선 완료)
  jq --arg date "$DAYS_AGO" '
    select(
      (.published >= ($date + "T00:00:00Z"))
      and any(.affected[]; .package.ecosystem | test("Ubuntu:22.04:LTS|Ubuntu:24.04:LTS"))
    )
    | {
        id: .id,
        vendor: "Canonical / Ubuntu",
        type: "Ubuntu Security Notice (USN)",
        title: (.summary // .id),
        issuedDate: .published,
        updatedDate: (.modified // .published),
        pubDate: .published,
        dateStr: (.published | split("T")[0]),
        url: ("https://ubuntu.com/security/notices/" + .id),
        severity: "None",
        overview: (.summary // ""),
        description: (.details // "상세 설명 없음"),
        affected_products: [
          .affected[] |
          select(.package.ecosystem | test("Ubuntu:22.04:LTS|Ubuntu:24.04:LTS")) |
          "Ubuntu " + (.package.ecosystem | split(":")[1]) + " LTS"
        ] | unique,
        cves: [ .aliases[]? | select(test("^CVE-")) ],
        packages: [
          .affected[] |
          select(.package.ecosystem | test("Ubuntu:22.04:LTS|Ubuntu:24.04:LTS")) |
          .ecosystem_specific.binaries[]? |
          "\(.binary_name)-\(.binary_version)"
        ] | unique,
        full_text: (.details // .summary // "")
      }
  ' "$file" > "../$DATA_DIR/temp_${ID}.json" 2>/dev/null || true

  if [ -s "../$DATA_DIR/temp_${ID}.json" ]; then
    mv "../$DATA_DIR/temp_${ID}.json" "../$DATA_DIR/${ID}.json"
    echo "✅ 생성 완료: ${ID}.json"
  else
    rm -f "../$DATA_DIR/temp_${ID}.json"
  fi
done

echo ""
echo "=== 작업 완료 ==="
echo "총 파일 수: $(ls ../$DATA_DIR/ 2>/dev/null | wc -l)"
echo "최근 생성 파일 예시:"
ls -lt ../$DATA_DIR/ | head -6
