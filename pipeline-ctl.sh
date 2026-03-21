#!/usr/bin/env bash
# pipeline-ctl.sh — Patch Review Dashboard 파이프라인 관리 스크립트
#
# 사용법:
#   ./pipeline-ctl.sh status              # 현재 상태 조회
#   ./pipeline-ctl.sh kill                # 실행 중인 AI 프로세스 종료 + lock 해제
#   ./pipeline-ctl.sh reset               # kill + queue 초기화 + DB 초기화
#   ./pipeline-ctl.sh restart             # reset + pm2 재시작
#   ./pipeline-ctl.sh start-all           # 전체 13개 제품 파이프라인 enqueue
#   ./pipeline-ctl.sh start <product_id>  # 특정 제품 파이프라인 enqueue
#   ./pipeline-ctl.sh recover             # restart + start-all (문제 발생 시 한 번에)
#
# 지원 제품 ID:
#   redhat oracle ubuntu windows ceph mariadb sqlserver pgsql vsphere jboss_eap tomcat wildfly mysql

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_PATH="$SCRIPT_DIR/prisma/patch-review.db"
LOCK_PATH="/tmp/openclaw_execution.lock"
PM2_APP="patch-dashboard"

# 제품 ID → BullMQ job name 매핑
declare -A JOB_NAMES=(
    [redhat]="run-redhat-pipeline"
    [oracle]="run-oracle-pipeline"
    [ubuntu]="run-ubuntu-pipeline"
    [windows]="run-windows-pipeline"
    [ceph]="run-ceph-pipeline"
    [mariadb]="run-mariadb-pipeline"
    [sqlserver]="run-sqlserver-pipeline"
    [pgsql]="run-pgsql-pipeline"
    [vsphere]="run-vsphere-pipeline"
    [jboss_eap]="run-jboss_eap-pipeline"
    [tomcat]="run-tomcat-pipeline"
    [wildfly]="run-wildfly-pipeline"
    [mysql]="run-mysql-pipeline"
)

# enqueue 순서 (OS → DB → Middleware → Storage)
ALL_PRODUCTS=(redhat oracle ubuntu windows pgsql mariadb sqlserver mysql jboss_eap tomcat wildfly ceph vsphere)

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; }

# ──────────────────────────────────────────────
cmd_status() {
    echo ""
    echo "═══════════════ Pipeline Status ═══════════════"

    # openclaw 프로세스
    local procs
    procs=$(pgrep -f openclaw 2>/dev/null | wc -l)
    if [[ "$procs" -gt 0 ]]; then
        echo -e "  AI Processes : ${GREEN}$procs openclaw running${NC}"
        pgrep -a openclaw 2>/dev/null | sed 's/^/    /'
    else
        echo -e "  AI Processes : ${YELLOW}none${NC}"
    fi

    # lock 상태
    if [[ -d "$LOCK_PATH" ]]; then
        local pid_in_lock=""
        [[ -f "$LOCK_PATH/pid" ]] && pid_in_lock=$(cat "$LOCK_PATH/pid")
        if [[ -n "$pid_in_lock" ]] && kill -0 "$pid_in_lock" 2>/dev/null; then
            echo -e "  Lock         : ${GREEN}held by PID $pid_in_lock (alive)${NC}"
        else
            echo -e "  Lock         : ${RED}STALE (PID $pid_in_lock dead)${NC}"
        fi
    else
        echo -e "  Lock         : ${YELLOW}free${NC}"
    fi

    # BullMQ 큐
    local active waiting completed failed
    active=$(redis-cli llen "bull:patch-pipeline:active" 2>/dev/null || echo 0)
    waiting=$(redis-cli llen "bull:patch-pipeline:wait" 2>/dev/null || echo 0)
    completed=$(redis-cli zcard "bull:patch-pipeline:completed" 2>/dev/null || echo 0)
    failed=$(redis-cli zcard "bull:patch-pipeline:failed" 2>/dev/null || echo 0)
    echo "  Queue        : active=$active  waiting=$waiting  completed=$completed  failed=$failed"

    # 현재 active job 정보
    if [[ "$active" -gt 0 ]]; then
        local job_id
        job_id=$(redis-cli lindex "bull:patch-pipeline:active" 0 2>/dev/null)
        local job_name progress
        job_name=$(redis-cli hget "bull:patch-pipeline:$job_id" name 2>/dev/null)
        progress=$(redis-cli hget "bull:patch-pipeline:$job_id" progress 2>/dev/null)
        echo -e "  Active Job   : ${GREEN}#$job_id $job_name (progress: ${progress}%)${NC}"
    fi

    # DB 카운트
    local pp rp
    pp=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM PreprocessedPatch;" 2>/dev/null || echo "?")
    rp=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM ReviewedPatch;" 2>/dev/null || echo "?")
    echo "  DB           : PreprocessedPatch=$pp  ReviewedPatch=$rp"

    # pm2 상태
    local pm2_status
    pm2_status=$(pm2 list --no-color 2>/dev/null | grep "$PM2_APP" | awk '{print $18}' | head -1)
    echo -e "  pm2          : ${pm2_status:-unknown}"
    echo "═══════════════════════════════════════════════"
    echo ""
}

# ──────────────────────────────────────────────
cmd_kill() {
    info "AI 프로세스 종료 및 lock 해제..."

    # openclaw 프로세스 종료
    local pids
    pids=$(pgrep -f openclaw 2>/dev/null || true)
    if [[ -n "$pids" ]]; then
        echo "$pids" | while read -r pid; do
            kill -9 "$pid" 2>/dev/null && info "Killed openclaw PID $pid" || true
        done
        sleep 1
    else
        info "실행 중인 openclaw 프로세스 없음"
    fi

    # stale lock 제거
    if [[ -d "$LOCK_PATH" ]]; then
        rm -rf "$LOCK_PATH"
        success "Lock 제거 완료: $LOCK_PATH"
    else
        info "Lock 없음"
    fi

    # session lock 파일 정리
    local sessions_dir="$HOME/.openclaw/agents/main/sessions"
    if [[ -d "$sessions_dir" ]]; then
        find "$sessions_dir" -name "*.lock" -delete 2>/dev/null || true
        info "Session lock 파일 정리 완료"
    fi
}

# ──────────────────────────────────────────────
cmd_reset() {
    info "전체 초기화 시작..."
    cmd_kill

    # BullMQ 큐 초기화
    local count
    count=$(redis-cli keys "bull:patch-pipeline:*" 2>/dev/null | xargs -r redis-cli del 2>/dev/null || echo 0)
    success "BullMQ 큐 초기화 ($count keys 삭제)"

    # DB 초기화
    sqlite3 "$DB_PATH" "DELETE FROM PreprocessedPatch; DELETE FROM ReviewedPatch;" 2>/dev/null
    success "DB 초기화 완료 (PreprocessedPatch, ReviewedPatch)"
}

# ──────────────────────────────────────────────
cmd_restart() {
    info "pm2 재시작..."
    cmd_reset
    pm2 restart "$PM2_APP" --update-env 2>/dev/null
    sleep 6
    local status
    status=$(pm2 list --no-color 2>/dev/null | grep "$PM2_APP" | awk '{print $18}' | head -1)
    if [[ "$status" == "online" ]]; then
        success "pm2 재시작 완료 (status: $status)"
    else
        error "pm2 재시작 후 상태 이상: $status"
        exit 1
    fi
}

# ──────────────────────────────────────────────
_enqueue_jobs() {
    # 인자로 받은 product ID 목록을 BullMQ에 직접 enqueue
    # API route의 flush 로직을 우회하여 모든 job을 한번에 등록
    local products=("$@")
    local enqueue_script="$SCRIPT_DIR/.enqueue_tmp.mjs"

    # 동적으로 enqueue script 생성
    {
        echo "import { Queue } from 'bullmq';"
        echo "import IORedis from 'ioredis';"
        echo "const connection = new IORedis({ host: '127.0.0.1', port: 6379, maxRetriesPerRequest: null });"
        echo "const queue = new Queue('patch-pipeline', { connection });"
        echo "const jobs = ["
        for pid in "${products[@]}"; do
            local jname="${JOB_NAMES[$pid]:-}"
            if [[ -z "$jname" ]]; then
                warn "알 수 없는 제품 ID: $pid (건너뜀)"
                continue
            fi
            # providers 필드는 Linux OS 제품에만 필요
            if [[ "$pid" == "redhat" || "$pid" == "oracle" || "$pid" == "ubuntu" ]]; then
                echo "  { name: '$jname', data: { providers: ['$pid'], isRetry: false, isAiOnly: false } },"
            else
                echo "  { name: '$jname', data: { isRetry: false, isAiOnly: false } },"
            fi
        done
        echo "];"
        echo "for (const j of jobs) {"
        echo "  const added = await queue.add(j.name, j.data);"
        echo "  console.log('Enqueued: ' + j.name + ' (jobId: ' + added.id + ')');"
        echo "}"
        echo "console.log('Total ' + jobs.length + ' jobs enqueued.');"
        echo "await connection.quit();"
    } > "$enqueue_script"

    (cd "$SCRIPT_DIR" && node "$enqueue_script" 2>&1)
    rm -f "$enqueue_script"
}

# ──────────────────────────────────────────────
cmd_start_all() {
    info "전체 ${#ALL_PRODUCTS[@]}개 제품 파이프라인 enqueue..."
    _enqueue_jobs "${ALL_PRODUCTS[@]}"
    success "전체 파이프라인 enqueue 완료"
}

# ──────────────────────────────────────────────
cmd_start_one() {
    local product_id="${1:-}"
    if [[ -z "$product_id" ]]; then
        error "제품 ID를 지정하세요. 예: $0 start redhat"
        echo "지원 제품: ${!JOB_NAMES[*]}"
        exit 1
    fi
    if [[ -z "${JOB_NAMES[$product_id]:-}" ]]; then
        error "알 수 없는 제품 ID: $product_id"
        echo "지원 제품: ${!JOB_NAMES[*]}"
        exit 1
    fi
    info "제품 '$product_id' 파이프라인 enqueue..."
    _enqueue_jobs "$product_id"
    success "파이프라인 enqueue 완료: $product_id"
}

# ──────────────────────────────────────────────
cmd_recover() {
    warn "장애 복구 모드: restart + start-all"
    cmd_restart
    sleep 2
    cmd_start_all
    echo ""
    success "복구 완료. 파이프라인 진행 상황:"
    sleep 3
    cmd_status
}

# ──────────────────────────────────────────────
# 메인
CMD="${1:-help}"
shift 2>/dev/null || true

case "$CMD" in
    status)     cmd_status ;;
    kill)       cmd_kill && success "완료" ;;
    reset)      cmd_reset && success "초기화 완료" ;;
    restart)    cmd_restart && success "재시작 완료" ;;
    start-all)  cmd_start_all ;;
    start)      cmd_start_one "${1:-}" ;;
    recover)    cmd_recover ;;
    help|--help|-h)
        echo ""
        echo "사용법: $(basename "$0") <command> [options]"
        echo ""
        echo "Commands:"
        echo "  status              현재 파이프라인 상태 조회"
        echo "  kill                openclaw 프로세스 종료 + stale lock 해제"
        echo "  reset               kill + BullMQ 큐 + DB 전체 초기화"
        echo "  restart             reset + pm2 재시작"
        echo "  start-all           전체 13개 제품 파이프라인 enqueue"
        echo "  start <product_id>  특정 제품만 enqueue"
        echo "  recover             restart + start-all (장애 복구 한 번에)"
        echo ""
        echo "제품 ID: ${!JOB_NAMES[*]}"
        echo ""
        ;;
    *)
        error "알 수 없는 명령: $CMD"
        echo "사용법: $0 help"
        exit 1
        ;;
esac
