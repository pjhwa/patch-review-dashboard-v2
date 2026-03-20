# Patch Review Board Dashboard - 기술 문서 인덱스

## Canonical AI Knowledge Layer (docs_canonical/)

AI 에이전트는 작업 전 아래 문서를 먼저 읽어야 합니다.

| 문서 | 설명 |
|------|------|
| [REPO_MAP](docs_canonical/REPO_MAP.md) | 레포 구조, 지원 제품, 주요 진입점, 의존성 |
| [ARCHITECTURE](docs_canonical/ARCHITECTURE.md) | 시스템 설계, 파이프라인 5단계, DB 스키마, API 라우트 |
| [WORKFLOWS](docs_canonical/WORKFLOWS.md) | 개발/빌드/배포/운영자 워크플로우, 신규 제품 추가 절차 |
| [STYLEGUIDE](docs_canonical/STYLEGUIDE.md) | 코딩 컨벤션, 네이밍, 주요 패턴, 안티패턴 |
| [TESTING](docs_canonical/TESTING.md) | Registry 검증, 빌드 검증, 수동 E2E 테스트 |
| [TASKS](docs_canonical/TASKS.md) | 현재 백로그, 확장 대상 제품, 완료된 이니셔티브 |

---

## 개요

Patch Review Board Dashboard는 분기별 권고 패치 검토 작업을 중앙에서 관제하고 자동화하는 컴플라이언스 운영 플랫폼입니다. BullMQ 작업 큐, 중앙 제품 레지스트리, OpenClaw AI 에이전트를 기반으로 9개 제품군의 패치를 자동 수집·분석·검토합니다.

---

## 문서 목록

### 아키텍처 & 설계
| 문서 | 설명 |
|------|------|
| [Architecture (EN)](docs/architecture.md) | 시스템 설계, 컴포넌트, BullMQ 큐 구조 |
| [Architecture (KO)](docs/architecture_ko.md) | 아키텍처 한국어 버전 |
| [Product Registry](docs/product_registry.md) | 중앙 제품 레지스트리 설계 및 ProductConfig 인터페이스 상세 |

### 파이프라인 & AI
| 문서 | 설명 |
|------|------|
| [Pipeline Flow (EN)](docs/pipeline_flow.md) | 0~7단계 파이프라인 전체 실행 흐름 |
| [Pipeline Flow (KO)](docs/pipeline_flow_ko.md) | 파이프라인 흐름 한국어 버전 |
| [AI Review (EN)](docs/ai_review.md) | AI 리뷰 루프, RAG 전략, Zod 자가 치유, 패스스루 |
| [AI Review (KO)](docs/ai_review_ko.md) | AI 리뷰 한국어 버전 |

### 기술 & 배포
| 문서 | 설명 |
|------|------|
| [Tech Stack (EN)](docs/tech_stack.md) | 기술 선택 및 버전 정보 |
| [Tech Stack (KO)](docs/tech_stack_ko.md) | 기술 스택 한국어 버전 |
| [Deployment Guide](docs/deployment.md) | 신규 환경 전체 구축 가이드 (Redis, Node, pm2 포함) |

### 제품 추가
| 문서 | 설명 |
|------|------|
| [Product Spec Template](docs/PRODUCT_SPEC_TEMPLATE.md) | 신규 제품 온보딩을 위한 스펙 작성 템플릿 |
| [Adding New Product](~/ADDING_NEW_PRODUCT.md) | 신규 제품 추가 7단계 체크리스트 |

---

## 배포 환경

- **운영 서버**: `tom26` 리눅스 서버 (`citec@<SERVER_IP>`)
- **애플리케이션 경로**: `~/patch-review-dashboard-v2/`
- **스킬 경로**: `~/.openclaw/workspace/skills/patch-review/`
- **포트**: 3001
- **프로세스 매니저**: pm2 (`patch-dashboard` 프로세스)
- **자동 시작**: `pm2-citec.service` (systemd)

## 지원 제품 (9개 활성)

| 제품 | 카테고리 | 작업 이름 |
|------|----------|----------|
| Red Hat Enterprise Linux | OS | `run-redhat-pipeline` |
| Oracle Linux | OS | `run-oracle-pipeline` |
| Ubuntu Linux | OS | `run-ubuntu-pipeline` |
| Windows Server | OS | `run-windows-pipeline` |
| Ceph | Storage | `run-ceph-pipeline` |
| MariaDB | Database | `run-mariadb-pipeline` |
| SQL Server | Database | `run-sqlserver-pipeline` |
| PostgreSQL | Database | `run-pgsql-pipeline` |
| VMware vSphere | Virtualization | `run-vsphere-pipeline` |
