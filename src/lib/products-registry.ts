import path from 'path';

/**
 * 제품(Product) 파이프라인 전체 설정을 담는 중앙 레지스트리 인터페이스.
 * 새 제품을 추가할 때 이 인터페이스를 구현한 객체를 PRODUCT_REGISTRY 배열에 추가하면 된다.
 */
export interface ProductConfig {
    id: string;                  // 내부 식별자 (라우팅, DB 조회에 사용)
    name: string;                // UI 표시 이름
    vendorString: string;        // DB의 vendor 필드 값 (preprocessedPatchMapper와 반드시 일치)
    category: 'os' | 'storage' | 'database' | 'virtualization' | 'middleware';
    active: boolean;             // false면 파이프라인 실행 대상에서 제외되고 PRODUCT_MAP에도 없음

    skillDirRelative: string;    // ~/.openclaw/workspace/skills/patch-review/ 기준 상대 경로
    rawDataFilePrefix: string[]; // 수집 파일 식별용 prefix (예: ['RHSA-', 'RHBA-'])

    preprocessingScript: string; // Python 전처리 스크립트 파일명
    preprocessingArgs: string[]; // 전처리 스크립트에 전달할 CLI 인수

    patchesForReviewFile: string; // 전처리 결과: AI 리뷰용 패치 목록 JSON
    aiReportFile: string;         // AI 리뷰 결과 저장 JSON
    finalCsvFile: string;         // 최종 승인 패치 CSV (관리자 finalize 시 생성)

    jobName: string;              // BullMQ 작업 이름 (워커에서 분기 식별에 사용)
    rateLimitFlag: string;        // Rate Limit 발생 시 생성되는 flag 파일 경로 (재개 모드 감지용)
    logTag: string;               // 로그 접두어 (예: '[REDHAT-PIPELINE]')

    aiEntityName: string;         // AI 프롬프트에서 대상을 설명하는 레이블
    aiVendorFieldValue: string;   // AI 출력의 Vendor 필드에 기대하는 값
    aiComponentDefault: string;   // AI가 Component를 비울 때 사용하는 기본값

    // true이면 개별 패치가 아닌 버전 그룹 단위로 평가 (현재 미사용, 하위 호환용)
    aiVersionGrouped: boolean;
    // 'exact': AI가 배치 크기와 정확히 같은 수의 항목을 반환해야 함
    // 'nonEmpty': 1개 이상만 반환해도 허용
    aiBatchValidation: 'exact' | 'nonEmpty';
    // 제품별 AI 배치 크기 (미설정 시 기본값 5 사용). OS버전 간 비교가 필요한 제품에 사용.
    aiBatchSize?: number;

    ragExclusion?: {
        // 'file-hiding': AI 호출 전 normalized/ 디렉토리와 패치 파일을 임시로 숨김 (file-hiding 전용)
        // 'prompt-injection': query_rag.py로 제외 규칙을 조회해 프롬프트에 직접 삽입 (Linux)
        // 'both': file-hiding + prompt-injection 동시 적용 (비Linux 제품 권장)
        type: 'file-hiding' | 'prompt-injection' | 'both';
        normalizedDirName?: string;      // file-hiding 시 숨길 디렉토리 (skillDir 기준 상대 경로)
        queryScript?: string;            // prompt-injection 시 실행할 RAG 조회 스크립트 (os/linux/ 기준 파일명)
        queryTextSampleSize?: number;    // RAG 쿼리에 사용할 샘플 패치 수
    };

    passthrough: {
        // enabled: AI가 건너뛴 패치를 fallback 값으로 ReviewedPatch에 자동 삽입할지 여부
        // 버전 그룹 방식(Windows, SQL Server)은 false로 설정해 불필요한 중간 항목이 생기지 않도록 함
        enabled: boolean;
        fallbackCriticality: string;
        fallbackDecision: string;
    };

    // rawDataFilePrefix 기준으로 수집 파일을 필터링하는 함수
    collectedFileFilter: (filename: string) => boolean;
    // 원시 수집 데이터(Python 출력)를 PreprocessedPatch DB 스키마 형태로 변환
    preprocessedPatchMapper: (raw: any) => object;
    csvBOM: boolean;             // true이면 BOM(UTF-8 BOM) 포함 CSV 생성 (Excel 한글 깨짐 방지)

    // 제품별 AI 프롬프트 생성 함수. skillDir 경로, 배치 크기, pruning된 패치 배열을 받아 문자열 반환
    buildPrompt: (skillDir: string, batchSize: number, prunedBatch: any[]) => string;
}

/**
 * 전체 제품 목록. active: false인 항목은 파이프라인 실행 대상에서 제외되지만
 * 레지스트리에는 남겨두어 향후 활성화를 위한 설정 템플릿으로 보존한다.
 */
export const PRODUCT_REGISTRY: ProductConfig[] = [
    {
        id: 'redhat',
        name: 'Red Hat Enterprise Linux',
        vendorString: 'Red Hat',
        category: 'os',
        active: true,
        skillDirRelative: 'os/linux',

        rawDataFilePrefix: ['RHSA-', 'RHBA-'],
        preprocessingScript: 'patch_preprocessing.py',
        preprocessingArgs: ['--vendor', 'redhat', '--days', '180'],
        patchesForReviewFile: 'patches_for_llm_review_redhat.json',
        aiReportFile: 'patch_review_ai_report_redhat.json',
        finalCsvFile: 'final_approved_patches_redhat.csv',
        jobName: 'run-redhat-pipeline',
        rateLimitFlag: '/tmp/.rate_limit_redhat',
        logTag: 'REDHAT',
        aiEntityName: 'Red Hat Linux patches',
        aiVendorFieldValue: 'Red Hat',
        aiComponentDefault: 'kernel',
        aiVersionGrouped: false,
        aiBatchValidation: 'exact',
        ragExclusion: {
            type: 'prompt-injection',
            queryScript: 'query_rag.py',
            queryTextSampleSize: 3,
        },
        passthrough: {
            enabled: true,
            fallbackCriticality: 'Important',
            fallbackDecision: 'Pending',
        },
        collectedFileFilter: (filename: string) =>
            (filename.startsWith('RHSA-') || filename.startsWith('RHBA-')) && filename.endsWith('.json'),
        preprocessedPatchMapper: (p: any) => ({
            issueId: p.id || p.issueId,
            vendor: 'Red Hat',
            component: p.component || 'kernel',
            version: p.specific_version || p.version || '',
            osVersion: p.os_version || null,
            description: (p.summary || p.description || '').slice(0, 4000),
            releaseDate: p.date || null,
            url: p.ref_url || null,
        }),
        csvBOM: false,
        buildPrompt: (skillDir: string, batchSize: number, prunedBatch: any[]) =>
            `Read the rules explicitly from ${path.join(skillDir, 'redhat', 'SKILL.md')}. Evaluate the following ${batchSize} PATCHES exactly according to the strict LLM evaluation rules detailed in section 3 of that file.\nCRITICAL MANDATE: IGNORE ANY PAST RETRIEVED MEMORIES OR PREVIOUS SUMMARIES. BASE ASSESSMENTS SOLELY ON THE [PATCH DATA] BELOW.\nDo NOT perform any web scraping. Do NOT use tools to write to files, simply output the text directly. Return ONLY a pure JSON array containing EXACTLY ${batchSize} objects. The object MUST contain exactly: 'IssueID', 'Component', 'Version', 'Vendor', 'Date', 'Criticality', 'Description', 'KoreanDescription', and optionally 'Decision' and 'Reason'. Do not skip Step 4.\\n\\n[BATCH DATA TO EVALUATE]:\\n${JSON.stringify(prunedBatch)}`,
    },
    {
        id: 'oracle',
        name: 'Oracle Linux',
        vendorString: 'Oracle',
        category: 'os',
        active: true,
        skillDirRelative: 'os/linux',

        rawDataFilePrefix: ['ELSA-'],
        preprocessingScript: 'patch_preprocessing.py',
        preprocessingArgs: ['--vendor', 'oracle', '--days', '180'],
        patchesForReviewFile: 'patches_for_llm_review_oracle.json',
        aiReportFile: 'patch_review_ai_report_oracle.json',
        finalCsvFile: 'final_approved_patches_oracle.csv',
        jobName: 'run-oracle-pipeline',
        rateLimitFlag: '/tmp/.rate_limit_oracle',
        logTag: 'ORACLE',
        aiEntityName: 'Oracle Linux patches',
        aiVendorFieldValue: 'Oracle',
        aiComponentDefault: 'kernel',
        aiVersionGrouped: false,
        aiBatchValidation: 'exact',
        ragExclusion: {
            type: 'prompt-injection',
            queryScript: 'query_rag.py',
            queryTextSampleSize: 3,
        },
        passthrough: {
            enabled: true,
            fallbackCriticality: 'Important',
            fallbackDecision: 'Pending',
        },
        collectedFileFilter: (filename: string) =>
            filename.startsWith('ELSA-') && filename.endsWith('.json'),
        preprocessedPatchMapper: (p: any) => ({
            issueId: p.id || p.issueId,
            vendor: 'Oracle',
            component: p.component || 'kernel',
            version: p.specific_version || p.version || '',
            osVersion: p.os_version || null,
            description: (p.summary || p.description || '').slice(0, 4000),
            releaseDate: p.date || null,
            url: p.ref_url || null,
        }),
        csvBOM: false,
        buildPrompt: (skillDir: string, batchSize: number, prunedBatch: any[]) =>
            `Read the rules explicitly from ${path.join(skillDir, 'oracle', 'SKILL.md')}. Evaluate the following ${batchSize} PATCHES exactly according to the strict LLM evaluation rules detailed in section 3 of that file.\nCRITICAL MANDATE: IGNORE ANY PAST RETRIEVED MEMORIES OR PREVIOUS SUMMARIES. BASE ASSESSMENTS SOLELY ON THE [PATCH DATA] BELOW.\nDo NOT perform any web scraping. Do NOT use tools to write to files, simply output the text directly. Return ONLY a pure JSON array containing EXACTLY ${batchSize} objects. The object MUST contain exactly: 'IssueID', 'Component', 'Version', 'Vendor', 'Date', 'Criticality', 'Description', 'KoreanDescription', and optionally 'Decision' and 'Reason'. Do not skip Step 4.\\n\\n[BATCH DATA TO EVALUATE]:\\n${JSON.stringify(prunedBatch)}`,
    },
    {
        id: 'ubuntu',
        name: 'Ubuntu Linux',
        vendorString: 'Ubuntu',
        category: 'os',
        active: true,
        skillDirRelative: 'os/linux',

        rawDataFilePrefix: ['USN-'],
        preprocessingScript: 'patch_preprocessing.py',
        preprocessingArgs: ['--vendor', 'ubuntu', '--days', '180'],
        patchesForReviewFile: 'patches_for_llm_review_ubuntu.json',
        aiReportFile: 'patch_review_ai_report_ubuntu.json',
        finalCsvFile: 'final_approved_patches_ubuntu.csv',
        jobName: 'run-ubuntu-pipeline',
        rateLimitFlag: '/tmp/.rate_limit_ubuntu',
        logTag: 'UBUNTU',
        aiEntityName: 'Ubuntu Linux patches',
        aiVendorFieldValue: 'Ubuntu',
        aiComponentDefault: 'kernel',
        aiVersionGrouped: false,
        aiBatchValidation: 'exact',
        ragExclusion: {
            type: 'prompt-injection',
            queryScript: 'query_rag.py',
            queryTextSampleSize: 3,
        },
        passthrough: {
            enabled: true,
            fallbackCriticality: 'Important',
            fallbackDecision: 'Pending',
        },
        collectedFileFilter: (filename: string) =>
            filename.startsWith('USN-') && filename.endsWith('.json'),
        preprocessedPatchMapper: (p: any) => ({
            issueId: p.id || p.issueId,
            vendor: 'Ubuntu',
            component: p.component || 'kernel',
            version: p.specific_version || p.version || '',
            osVersion: p.os_version || null,
            description: (p.summary || p.description || '').slice(0, 4000),
            releaseDate: p.date || null,
            url: p.ref_url || null,
        }),
        csvBOM: false,
        buildPrompt: (skillDir: string, batchSize: number, prunedBatch: any[]) =>
            `Read the rules explicitly from ${path.join(skillDir, 'ubuntu', 'SKILL.md')}. Evaluate the following ${batchSize} PATCHES exactly according to the strict LLM evaluation rules detailed in section 3 of that file.\nCRITICAL MANDATE: IGNORE ANY PAST RETRIEVED MEMORIES OR PREVIOUS SUMMARIES. BASE ASSESSMENTS SOLELY ON THE [PATCH DATA] BELOW.\nDo NOT perform any web scraping. Do NOT use tools to write to files, simply output the text directly. Return ONLY a pure JSON array containing EXACTLY ${batchSize} objects. The object MUST contain exactly: 'IssueID', 'Component', 'Version', 'Vendor', 'Date', 'Criticality', 'Description', 'KoreanDescription', and optionally 'Decision' and 'Reason'. Do not skip Step 4.\\n\\n[BATCH DATA TO EVALUATE]:\\n${JSON.stringify(prunedBatch)}`,
    },
    {
        id: 'windows',
        name: 'Windows Server',
        vendorString: 'Windows Server',
        category: 'os',
        active: true,
        skillDirRelative: 'os/windows',

        rawDataFilePrefix: ['WIN-'],
        preprocessingScript: 'windows_preprocessing.py',
        preprocessingArgs: ['--days', '180', '--days_end', '90'],
        patchesForReviewFile: 'patches_for_llm_review_windows.json',
        aiReportFile: 'patch_review_ai_report_windows.json',
        finalCsvFile: 'final_approved_patches_windows.csv',
        jobName: 'run-windows-pipeline',
        rateLimitFlag: '/tmp/.rate_limit_windows',
        logTag: 'WINDOWS',
        aiEntityName: 'Windows Server cumulative update patches',
        aiVendorFieldValue: 'Windows Server',
        aiComponentDefault: 'cumulative-update',
        aiVersionGrouped: false,
        aiBatchValidation: 'exact',
        aiBatchSize: 15,
        ragExclusion: {
            type: 'both',
            normalizedDirName: 'windows_data/normalized',
            queryScript: 'query_rag.py',
            queryTextSampleSize: 3,
        },
        passthrough: {
            // AI가 모든 개별 패치를 검토하고 Exclude 결정을 내리므로 passthrough 불필요
            enabled: false,
            fallbackCriticality: 'Important',
            fallbackDecision: 'Pending',
        },
        collectedFileFilter: (filename: string) =>
            filename.startsWith('WIN-') && filename.endsWith('.json'),
        preprocessedPatchMapper: (p: any) => ({
            issueId: p.patch_id,
            vendor: 'Windows Server',
            component: p.component || 'cumulative-update',
            version: p.version || '',
            osVersion: p.os_version || null,
            description: (p.description || '').slice(0, 4000),
            releaseDate: p.issued_date || null,
            url: p.url || null,
        }),
        csvBOM: true,
        buildPrompt: (skillDir: string, batchSize: number, prunedBatch: any[]) =>
            `Read the rules explicitly from ${path.join(skillDir, 'SKILL.md')}. Evaluate the following ${batchSize} Windows Server cumulative update patches according to the strict LLM evaluation rules in section 4 of that file.\nCRITICAL MANDATE: DO NOT USE ANY TOOLS TO READ OR SEARCH THE WORKSPACE JSON FILES. IGNORE ANY PREVIOUS EXAMPLES or RAG retrievals. You must ONLY base your evaluation on the literal text provided below in [BATCH DATA].\nINPUT FORMAT: Each entry in [BATCH DATA] is an individual monthly cumulative update patch with fields: patch_id, os_version, version (KB number), severity, description, issued_date.\nSELECTION RULE: The patches in [BATCH DATA] are sorted by os_version. For each os_version, you will find multiple monthly patches. Compare all patches with the same os_version and select EXACTLY ONE that: (1) fixes the most critical security vulnerabilities or system stability issues, AND (2) has no blocking known issues. Mark the selected patch Decision='Done', all others of the same os_version Decision='Exclude'.\nOUTPUT RULE: Return EXACTLY ${batchSize} objects (one per input patch). IssueID = the patch's patch_id field exactly. Version = the KB number from the version field. OsVersion = the os_version field value.\nCRITICAL RULE FOR DESCRIPTIONS: The 'Description' and 'KoreanDescription' fields MUST be a concise 1-2 sentence executive summary of the most critical security/stability issue fixed. For Exclude patches, summarize why they were not selected.\nEach object MUST contain exactly: 'IssueID', 'Component', 'Version', 'Vendor', 'OsVersion', 'Date', 'Criticality', 'Description', 'KoreanDescription', 'Decision', 'Reason'. For Vendor use 'Windows Server'. For Component use 'cumulative-update'.\n\n[BATCH DATA]:\n${JSON.stringify(prunedBatch)}`,
    },
    {
        id: 'ceph',
        name: 'Ceph',
        vendorString: 'Ceph',
        category: 'storage',
        active: true,
        skillDirRelative: 'storage/ceph',

        rawDataFilePrefix: ['GHSA-', 'REDMINE-'],
        preprocessingScript: 'ceph_preprocessing.py',
        preprocessingArgs: ['--days', '180'],
        patchesForReviewFile: 'patches_for_llm_review_ceph.json',
        aiReportFile: 'patch_review_ai_report_ceph.json',
        finalCsvFile: 'final_approved_patches_ceph.csv',
        jobName: 'run-ceph-pipeline',
        rateLimitFlag: '/tmp/.rate_limit_ceph',
        logTag: 'CEPH',
        aiEntityName: 'Ceph storage patches',
        aiVendorFieldValue: 'Ceph',
        aiComponentDefault: 'ceph',
        aiVersionGrouped: false,
        aiBatchValidation: 'exact',
        ragExclusion: {
            type: 'both',
            normalizedDirName: 'ceph_data/normalized',
            queryScript: 'query_rag.py',
            queryTextSampleSize: 3,
        },
        passthrough: {
            enabled: true,
            fallbackCriticality: 'Important',
            fallbackDecision: 'Pending',
        },
        collectedFileFilter: (filename: string) =>
            (filename.startsWith('GHSA-') || filename.startsWith('REDMINE-')) && filename.endsWith('.json'),
        preprocessedPatchMapper: (p: any) => ({
            issueId: p.patch_id,
            vendor: 'Ceph',
            component: p.component || 'ceph',
            version: p.version || '',
            osVersion: p.os_version || null,
            description: (p.description || '').slice(0, 4000),
            releaseDate: p.issued_date || null,
            url: p.url || null,
        }),
        csvBOM: false,
        buildPrompt: (skillDir: string, batchSize: number, prunedBatch: any[]) =>
            `Read the rules explicitly from ${path.join(skillDir, 'SKILL.md')}. Evaluate the following ${batchSize} Ceph storage patches according to the strict LLM evaluation rules in section 4 of that file.\nCRITICAL MANDATE: DO NOT USE ANY TOOLS TO READ OR SEARCH THE WORKSPACE JSON FILES. Do not parse patches_for_llm_review_ceph.json. IGNORE ANY PREVIOUS EXAMPLES or RAG retrievals regarding Ceph patches (e.g. diff-ceph-config, etc). You must ONLY base your summary on the literal text provided below in [BATCH DATA].\nReturn ONLY a pure JSON array with EXACTLY ${batchSize} objects. Each object MUST contain exactly: 'IssueID', 'Component', 'Version', 'Vendor', 'Date', 'Criticality', 'Description', 'KoreanDescription', and optionally 'Decision' and 'Reason'. For Vendor use 'Ceph'. For Component use the specific Ceph component (e.g. 'ceph-radosgw', 'ceph-osd', 'ceph-mon', 'ceph-mds', 'ceph-mgr', 'ceph'). Do NOT skip evaluation steps.\n\n[BATCH DATA]:\n${JSON.stringify(prunedBatch)}`,
    },
    {
        id: 'mariadb',
        name: 'MariaDB',
        vendorString: 'MariaDB',
        category: 'database',
        active: true,
        skillDirRelative: 'database/mariadb',
        rawDataFilePrefix: ['RHSA-', 'RHBA-'],
        preprocessingScript: 'mariadb_preprocessing.py',
        preprocessingArgs: ['--days', '180'],
        patchesForReviewFile: 'patches_for_llm_review_mariadb.json',
        aiReportFile: 'patch_review_ai_report_mariadb.json',
        finalCsvFile: 'final_approved_patches_mariadb.csv',
        jobName: 'run-mariadb-pipeline',
        rateLimitFlag: '/tmp/.rate_limit_mariadb',
        logTag: 'MARIADB',
        aiEntityName: 'MariaDB database patches',
        aiVendorFieldValue: 'MariaDB',
        aiComponentDefault: 'mariadb',
        aiVersionGrouped: false,
        aiBatchValidation: 'exact',
        ragExclusion: {
            type: 'both',
            normalizedDirName: 'mariadb_data/normalized',
            queryScript: 'query_rag.py',
            queryTextSampleSize: 3,
        },
        passthrough: {
            enabled: true,
            fallbackCriticality: 'Important',
            fallbackDecision: 'Pending',
        },
        collectedFileFilter: (filename: string) =>
            (filename.startsWith('RHSA-') || filename.startsWith('RHBA-')) && filename.endsWith('.json'),
        preprocessedPatchMapper: (p: any) => ({
            issueId: p.patch_id,
            vendor: 'MariaDB',
            component: p.component || 'mariadb',
            version: p.version || '',
            osVersion: p.os_version || null,
            description: (p.description || '').slice(0, 4000),
            releaseDate: p.issued_date || null,
            url: p.ref_url || null,
        }),
        csvBOM: true,
        buildPrompt: (skillDir: string, batchSize: number, prunedBatch: any[]) =>
            `Read the rules explicitly from ${path.join(skillDir, 'SKILL.md')}. Evaluate the following ${batchSize} MariaDB database patches according to the strict LLM evaluation rules in section 4 of that file.\nCRITICAL MANDATE: DO NOT USE ANY TOOLS TO READ OR SEARCH THE WORKSPACE JSON FILES. Do not parse patches_for_llm_review_mariadb.json. IGNORE ANY PREVIOUS EXAMPLES or RAG retrievals. You must ONLY base your summary on the literal text provided below in [BATCH DATA].\nCRITICAL RULE FOR DESCRIPTIONS: The 'Description' and 'KoreanDescription' fields MUST be a concise, executive summary of the bug fixes and features. DO NOT include verbatim '.patch' filenames, raw code snippets, or raw changelog copy-pastes. Describe WHAT was fixed and WHY, not HOW the file was named.\nReturn ONLY a pure JSON array with EXACTLY ${batchSize} objects. Each object MUST contain exactly: 'IssueID', 'Component', 'Version', 'Vendor', 'Date', 'Criticality', 'Description', 'KoreanDescription', and optionally 'Decision' and 'Reason'. For Vendor use 'MariaDB'. For Component use the specific MariaDB component (e.g. 'mariadb', 'mariadb-galera'). Do NOT skip evaluation steps.\n\n[BATCH DATA]:\n${JSON.stringify(prunedBatch)}`,
    },
    {
        id: 'sqlserver',
        name: 'SQL Server',
        vendorString: 'SQL Server',
        category: 'database',
        active: true,
        skillDirRelative: 'database/sqlserver',
        rawDataFilePrefix: ['SQLU-'],
        preprocessingScript: 'sqlserver_preprocessing.py',
        preprocessingArgs: ['--days', '180', '--days_end', '90'],
        patchesForReviewFile: 'patches_for_llm_review_sqlserver.json',
        aiReportFile: 'patch_review_ai_report_sqlserver.json',
        finalCsvFile: 'final_approved_patches_sqlserver.csv',
        jobName: 'run-sqlserver-pipeline',
        rateLimitFlag: '/tmp/.rate_limit_sqlserver',
        logTag: 'SQLSERVER',
        aiEntityName: 'Microsoft SQL Server VERSION GROUPS',
        aiVendorFieldValue: 'SQL Server',
        aiComponentDefault: 'SQL Server',
        aiVersionGrouped: true,
        aiBatchValidation: 'nonEmpty',
        ragExclusion: {
            type: 'both',
            normalizedDirName: 'sql_data/normalized',
            queryScript: 'query_rag.py',
            queryTextSampleSize: 3,
        },
        passthrough: {
            enabled: false,
            fallbackCriticality: 'Important',
            fallbackDecision: 'Pending',
        },
        collectedFileFilter: (filename: string) =>
            filename.startsWith('SQLU-') && filename.endsWith('.json'),
        preprocessedPatchMapper: (p: any) => ({
            issueId: p.patch_id,
            vendor: 'SQL Server',
            component: p.component || 'SQL Server',
            version: p.version || '',
            osVersion: p.os_version || null,
            description: (p.description || '').slice(0, 4000),
            releaseDate: p.issued_date || null,
            url: p.url || null,
        }),
        csvBOM: true,
        buildPrompt: (skillDir: string, batchSize: number, prunedBatch: any[]) =>
            `Read the rules explicitly from ${path.join(skillDir, 'SKILL.md')}. Evaluate the following ${batchSize} Microsoft SQL Server VERSION GROUPS according to the strict LLM evaluation rules in section 4 of that file.\nCRITICAL MANDATE: DO NOT USE ANY TOOLS TO READ OR SEARCH THE WORKSPACE JSON FILES. Do not parse patches_for_llm_review_sqlserver.json. IGNORE ANY PREVIOUS EXAMPLES or RAG retrievals. You must ONLY base your summary on the literal text provided below in [BATCH DATA].\nINPUT FORMAT: Each entry in [BATCH DATA] is a VERSION GROUP containing a 'patches' array of monthly cumulative updates for that SQL Server version. The group's patch_id is in the format 'SQLS-GROUP-<version>'.\nSELECTION RULE: For each VERSION GROUP, select the SINGLE MOST RECENT monthly patch (from the 'patches' array) that contains a fix for a critical security vulnerability or critical system stability issue. If no patch in the group meets critical criteria, EXCLUDE the entire group (set Decision to 'Exclude').\nOUTPUT RULE: Return EXACTLY ${batchSize} objects (one per input VERSION GROUP). IssueID = the GROUP's patch_id (e.g. 'SQLS-GROUP-SQL_Server_2022'). Version = the CU number/KB of the SELECTED monthly patch. OsVersion = the SQL Server version string.\nCRITICAL RULE FOR DESCRIPTIONS: The 'Description' and 'KoreanDescription' fields MUST be a concise 1-2 sentence executive summary of WHY the selected patch is critical. Focus on the specific critical vulnerability or stability issue fixed.\nEach object MUST contain exactly: 'IssueID', 'Component', 'Version', 'Vendor', 'OsVersion', 'Date', 'Criticality', 'Description', 'KoreanDescription', 'Decision', 'Reason'. For Vendor use 'SQL Server'. For Component use 'SQL Server'.\n\n[BATCH DATA]:\n${JSON.stringify(prunedBatch)}`,
    },
    {
        id: 'pgsql',
        name: 'PostgreSQL',
        vendorString: 'PostgreSQL',
        category: 'database',
        active: true,
        skillDirRelative: 'database/pgsql',
        rawDataFilePrefix: ['PGSL-'],
        preprocessingScript: 'pgsql_preprocessing.py',
        preprocessingArgs: ['--days', '180'],
        patchesForReviewFile: 'patches_for_llm_review_pgsql.json',
        aiReportFile: 'patch_review_ai_report_pgsql.json',
        finalCsvFile: 'final_approved_patches_pgsql.csv',
        jobName: 'run-pgsql-pipeline',
        rateLimitFlag: '/tmp/.rate_limit_pgsql',
        logTag: 'PGSQL',
        aiEntityName: 'PostgreSQL database patches',
        aiVendorFieldValue: 'PostgreSQL',
        aiComponentDefault: 'postgresql',
        aiVersionGrouped: false,
        aiBatchValidation: 'exact',
        ragExclusion: {
            type: 'both',
            normalizedDirName: 'pgsql_data/normalized',
            queryScript: 'query_rag.py',
            queryTextSampleSize: 3,
        },
        passthrough: {
            enabled: true,
            fallbackCriticality: 'Important',
            fallbackDecision: 'Pending',
        },
        collectedFileFilter: (filename: string) =>
            filename.startsWith('PGSL-') && filename.endsWith('.json'),
        preprocessedPatchMapper: (p: any) => ({
            issueId: p.patch_id,
            vendor: 'PostgreSQL',
            component: p.component || 'postgresql',
            version: p.version || '',
            osVersion: p.os_version || null,
            description: (p.description || '').slice(0, 4000),
            releaseDate: p.issued_date || null,
            url: p.ref_url || null,
        }),
        csvBOM: false,
        buildPrompt: (skillDir: string, batchSize: number, prunedBatch: any[]) =>
            `Read the rules explicitly from ${path.join(skillDir, 'SKILL.md')}. Evaluate the following ${batchSize} PostgreSQL database patches according to the strict LLM evaluation rules in section 4 of that file.\nCRITICAL MANDATE: DO NOT USE ANY TOOLS TO READ OR SEARCH THE WORKSPACE JSON FILES. Do not parse patches_for_llm_review_pgsql.json. IGNORE ANY PREVIOUS EXAMPLES or RAG retrievals. You must ONLY base your summary on the literal text provided below in [BATCH DATA].\nCRITICAL RULE FOR DESCRIPTIONS: The 'Description' and 'KoreanDescription' fields MUST be a concise, executive summary of the bug fixes and features. DO NOT include verbatim '.patch' filenames, raw code snippets, or raw changelog copy-pastes. Describe WHAT was fixed and WHY, not HOW the file was named.\nReturn ONLY a pure JSON array with EXACTLY ${batchSize} objects. Each object MUST contain exactly: 'IssueID', 'Component', 'Version', 'Vendor', 'Date', 'Criticality', 'Description', 'KoreanDescription', and optionally 'Decision' and 'Reason'. For Vendor use 'PostgreSQL'. For Component use the specific PostgreSQL component (e.g. 'postgresql', 'postgresql-server'). Do NOT skip evaluation steps.\n\n[BATCH DATA]:\n${JSON.stringify(prunedBatch)}`,
    },
    {
        id: 'vsphere',
        name: 'VMware vSphere',
        vendorString: 'VMware vSphere',
        category: 'virtualization',
        active: true,
        skillDirRelative: 'virtualization/vsphere',
        rawDataFilePrefix: ['VSPH-'],
        preprocessingScript: 'vsphere_preprocessing.py',
        preprocessingArgs: ['--days', '180'],
        patchesForReviewFile: 'patches_for_llm_review_vsphere.json',
        aiReportFile: 'patch_review_ai_report_vsphere.json',
        finalCsvFile: 'final_approved_patches_vsphere.csv',
        jobName: 'run-vsphere-pipeline',
        rateLimitFlag: '/tmp/.rate_limit_vsphere',
        logTag: 'VSPHERE',
        aiEntityName: 'VMware vSphere patches',
        aiVendorFieldValue: 'VMware vSphere',
        aiComponentDefault: 'vsphere',
        aiVersionGrouped: false,
        aiBatchValidation: 'exact',
        ragExclusion: {
            type: 'prompt-injection',
            queryScript: 'query_rag.py',
            queryTextSampleSize: 3,
        },
        passthrough: {
            enabled: true,
            fallbackCriticality: 'Important',
            fallbackDecision: 'Pending',
        },
        collectedFileFilter: (filename: string) =>
            filename.startsWith('VSPH-') && filename.endsWith('.json'),
        preprocessedPatchMapper: (p: any) => ({
            issueId: p.patch_id,
            vendor: 'VMware vSphere',
            component: p.product || 'vsphere',
            version: p.product || '',
            osVersion: null,
            description: (p.description || '').slice(0, 4000),
            releaseDate: p.published || null,
            url: p.url || null,
        }),
        csvBOM: false,
        buildPrompt: (skillDir: string, batchSize: number, prunedBatch: any[]) =>
            `Read the rules explicitly from ${path.join(skillDir, 'SKILL.md')}. Evaluate the following ${batchSize} VMware vSphere patches according to the strict LLM evaluation rules in section 4 of that file.\nCRITICAL MANDATE: DO NOT USE ANY TOOLS TO READ OR SEARCH THE WORKSPACE JSON FILES. Do not parse patches_for_llm_review_vsphere.json. IGNORE ANY PREVIOUS EXAMPLES or RAG retrievals. You must ONLY base your summary on the literal text provided below in [BATCH DATA].\nCRITICAL RULE FOR DESCRIPTIONS: The 'Description' and 'KoreanDescription' fields MUST be a concise, executive summary of the security advisories and bug fixes. DO NOT include verbatim file names or raw changelog copy-pastes. Describe WHAT was fixed and WHY it matters.\nReturn ONLY a pure JSON array with EXACTLY ${batchSize} objects. Each object MUST contain exactly: 'IssueID', 'Component', 'Version', 'Vendor', 'Date', 'Criticality', 'Description', 'KoreanDescription', and optionally 'Decision' and 'Reason'. For Vendor use 'VMware vSphere'. For Component use the specific product (e.g. 'ESXi', 'vCenter Server'). Do NOT skip evaluation steps.\n\n[BATCH DATA]:\n${JSON.stringify(prunedBatch)}`,
    },
    {
        id: 'jboss_eap',
        name: 'JBoss EAP',
        vendorString: 'JBoss EAP',
        category: 'middleware',
        active: true,
        skillDirRelative: 'middleware/jboss_eap',
        rawDataFilePrefix: ['RHSA-', 'RHBA-'],
        preprocessingScript: 'jboss_eap_preprocessing.py',
        preprocessingArgs: ['--days', '180'],
        patchesForReviewFile: 'patches_for_llm_review_jboss_eap.json',
        aiReportFile: 'patch_review_ai_report_jboss_eap.json',
        finalCsvFile: 'final_approved_patches_jboss_eap.csv',
        jobName: 'run-jboss_eap-pipeline',
        rateLimitFlag: '/tmp/.rate_limit_jboss_eap',
        logTag: 'JBOSS_EAP',
        aiEntityName: 'JBoss Enterprise Application Platform patches',
        aiVendorFieldValue: 'JBoss EAP',
        aiComponentDefault: 'jboss-eap',
        aiVersionGrouped: false,
        aiBatchValidation: 'exact',
        ragExclusion: {
            type: 'both',
            normalizedDirName: 'jboss_eap_data/normalized',
            queryScript: 'query_rag.py',
            queryTextSampleSize: 3,
        },
        passthrough: {
            enabled: true,
            fallbackCriticality: 'Important',
            fallbackDecision: 'Pending',
        },
        collectedFileFilter: (filename: string) =>
            (filename.startsWith('RHSA-') || filename.startsWith('RHBA-')) && filename.endsWith('.json'),
        preprocessedPatchMapper: (p: any) => ({
            issueId: p.patch_id,
            vendor: 'JBoss EAP',
            component: p.component || 'jboss-eap',
            version: p.version || '',
            osVersion: p.os_version || null,
            description: (p.description || '').slice(0, 4000),
            releaseDate: p.issued_date || null,
            url: p.ref_url || null,
        }),
        csvBOM: true,
        buildPrompt: (skillDir: string, batchSize: number, prunedBatch: any[]) =>
            `Read the rules explicitly from ${path.join(skillDir, 'SKILL.md')}. Evaluate the following ${batchSize} JBoss Enterprise Application Platform patches according to the strict LLM evaluation rules in section 4 of that file.\nCRITICAL MANDATE: DO NOT USE ANY TOOLS TO READ OR SEARCH THE WORKSPACE JSON FILES. Do not parse patches_for_llm_review_jboss_eap.json. IGNORE ANY PREVIOUS EXAMPLES or RAG retrievals. You must ONLY base your summary on the literal text provided below in [BATCH DATA].\nCRITICAL RULE FOR DESCRIPTIONS: The 'Description' and 'KoreanDescription' fields MUST be a concise, executive summary of the CVEs fixed and their security impact. DO NOT list raw CVE IDs verbatim — describe the vulnerability type and risk. Describe WHAT was fixed and WHY it matters for JBoss EAP deployments.\nCRITICAL RULE FOR LOG4SHELL: If the batch contains CVE-2021-44228 or CVE-2021-45046, always set Criticality to 'Critical' and Decision to 'Include' regardless of the advisory severity label.\nReturn ONLY a pure JSON array with EXACTLY ${batchSize} objects. Each object MUST contain exactly: 'IssueID', 'Component', 'Version', 'Vendor', 'Date', 'Criticality', 'Description', 'KoreanDescription', and optionally 'Decision' and 'Reason'. For Vendor use 'JBoss EAP'. For Component use 'jboss-eap' or 'jboss-eap-xp'. Do NOT skip evaluation steps.\n\n[BATCH DATA]:\n${JSON.stringify(prunedBatch)}`,
    },
    {
        id: 'tomcat',
        name: 'Apache Tomcat',
        vendorString: 'Apache Tomcat',
        category: 'middleware',
        active: true,
        skillDirRelative: 'middleware/tomcat',
        rawDataFilePrefix: ['TOMC-'],
        preprocessingScript: 'tomcat_preprocessing.py',
        preprocessingArgs: ['--days', '180'],
        patchesForReviewFile: 'patches_for_llm_review_tomcat.json',
        aiReportFile: 'patch_review_ai_report_tomcat.json',
        finalCsvFile: 'final_approved_patches_tomcat.csv',
        jobName: 'run-tomcat-pipeline',
        rateLimitFlag: '/tmp/.rate_limit_tomcat',
        logTag: 'TOMCAT',
        aiEntityName: 'Apache Tomcat security patches',
        aiVendorFieldValue: 'Apache Tomcat',
        aiComponentDefault: 'tomcat',
        aiVersionGrouped: false,
        aiBatchValidation: 'exact',
        ragExclusion: {
            type: 'both',
            normalizedDirName: 'tomcat_data/normalized',
            queryScript: 'query_rag.py',
            queryTextSampleSize: 3,
        },
        passthrough: {
            enabled: true,
            fallbackCriticality: 'Important',
            fallbackDecision: 'Pending',
        },
        collectedFileFilter: (filename: string) =>
            filename.startsWith('TOMC-') && filename.endsWith('.json'),
        preprocessedPatchMapper: (p: any) => ({
            issueId: p.patch_id,
            vendor: 'Apache Tomcat',
            component: p.component || 'tomcat',
            version: p.version || '',
            osVersion: p.os_version || null,
            description: (p.description || '').slice(0, 4000),
            releaseDate: p.issued_date || null,
            url: p.ref_url || null,
        }),
        csvBOM: false,
        buildPrompt: (skillDir: string, batchSize: number, prunedBatch: any[]) =>
            `Read the rules explicitly from ${path.join(skillDir, 'SKILL.md')}. Evaluate the following ${batchSize} Apache Tomcat security patches according to the strict LLM evaluation rules in section 4 of that file.\nCRITICAL MANDATE: DO NOT USE ANY TOOLS TO READ OR SEARCH THE WORKSPACE JSON FILES. Do not parse patches_for_llm_review_tomcat.json. IGNORE ANY PREVIOUS EXAMPLES or RAG retrievals. You must ONLY base your summary on the literal text provided below in [BATCH DATA].\nCRITICAL RULE FOR DESCRIPTIONS: The 'Description' and 'KoreanDescription' fields MUST be a concise, executive summary of the CVEs fixed and their security impact. DO NOT list raw CVE IDs verbatim — describe the vulnerability type and risk. Describe WHAT was fixed and WHY it matters for Tomcat deployments.\nReturn ONLY a pure JSON array with EXACTLY ${batchSize} objects. Each object MUST contain exactly: 'IssueID', 'Component', 'Version', 'Vendor', 'Date', 'Criticality', 'Description', 'KoreanDescription', and optionally 'Decision' and 'Reason'. For Vendor use 'Apache Tomcat'. For Component use 'tomcat'. Do NOT skip evaluation steps.\n\n[BATCH DATA]:\n${JSON.stringify(prunedBatch)}`,
    },
    {
        id: 'wildfly',
        name: 'WildFly',
        vendorString: 'WildFly',
        category: 'middleware',
        active: true,
        skillDirRelative: 'middleware/wildfly',
        rawDataFilePrefix: ['WFLY-'],
        preprocessingScript: 'wildfly_preprocessing.py',
        preprocessingArgs: ['--days', '180'],
        patchesForReviewFile: 'patches_for_llm_review_wildfly.json',
        aiReportFile: 'patch_review_ai_report_wildfly.json',
        finalCsvFile: 'final_approved_patches_wildfly.csv',
        jobName: 'run-wildfly-pipeline',
        rateLimitFlag: '/tmp/.rate_limit_wildfly',
        logTag: 'WILDFLY',
        aiEntityName: 'WildFly application server security patches',
        aiVendorFieldValue: 'WildFly',
        aiComponentDefault: 'wildfly',
        aiVersionGrouped: false,
        aiBatchValidation: 'exact',
        ragExclusion: {
            type: 'both',
            normalizedDirName: 'wildfly_data/normalized',
            queryScript: 'query_rag.py',
            queryTextSampleSize: 3,
        },
        passthrough: {
            enabled: true,
            fallbackCriticality: 'Important',
            fallbackDecision: 'Pending',
        },
        collectedFileFilter: (filename: string) =>
            filename.startsWith('WFLY-') && filename.endsWith('.json'),
        preprocessedPatchMapper: (p: any) => ({
            issueId: p.patch_id,
            vendor: 'WildFly',
            component: p.component || 'wildfly',
            version: p.version || '',
            osVersion: p.os_version || null,
            description: (p.description || '').slice(0, 4000),
            releaseDate: p.issued_date || null,
            url: p.ref_url || null,
        }),
        csvBOM: false,
        buildPrompt: (skillDir: string, batchSize: number, prunedBatch: any[]) =>
            `Read the rules explicitly from ${path.join(skillDir, 'SKILL.md')}. Evaluate the following ${batchSize} WildFly application server security patches according to the strict LLM evaluation rules in section 4 of that file.\nCRITICAL MANDATE: DO NOT USE ANY TOOLS TO READ OR SEARCH THE WORKSPACE JSON FILES. Do not parse patches_for_llm_review_wildfly.json. IGNORE ANY PREVIOUS EXAMPLES or RAG retrievals. You must ONLY base your summary on the literal text provided below in [BATCH DATA].\nCRITICAL RULE FOR DESCRIPTIONS: The 'Description' and 'KoreanDescription' fields MUST be a concise, executive summary of the CVEs fixed and their security impact. Focus on the specific vulnerability type (RCE, deserialization, SSRF, etc.) and affected subsystem. Describe WHAT was fixed and WHY it matters for WildFly deployments.\nReturn ONLY a pure JSON array with EXACTLY ${batchSize} objects. Each object MUST contain exactly: 'IssueID', 'Component', 'Version', 'Vendor', 'Date', 'Criticality', 'Description', 'KoreanDescription', and optionally 'Decision' and 'Reason'. For Vendor use 'WildFly'. For Component use 'wildfly'. Do NOT skip evaluation steps.\n\n[BATCH DATA]:\n${JSON.stringify(prunedBatch)}`,
    },
    {
        id: 'mysql',
        name: 'MySQL Community',
        vendorString: 'MySQL Community',
        category: 'database',
        active: true,
        skillDirRelative: 'database/mysql',
        rawDataFilePrefix: ['MYSQ-'],
        preprocessingScript: 'mysql_preprocessing.py',
        preprocessingArgs: ['--days', '180'],
        patchesForReviewFile: 'patches_for_llm_review_mysql.json',
        aiReportFile: 'patch_review_ai_report_mysql.json',
        finalCsvFile: 'final_approved_patches_mysql.csv',
        jobName: 'run-mysql-pipeline',
        rateLimitFlag: '/tmp/.rate_limit_mysql',
        logTag: 'MYSQL',
        aiEntityName: 'MySQL Community Oracle CPU patches',
        aiVendorFieldValue: 'MySQL Community',
        aiComponentDefault: 'mysql',
        aiVersionGrouped: false,
        aiBatchValidation: 'exact',
        ragExclusion: {
            type: 'both',
            normalizedDirName: 'mysql_data/normalized',
            queryScript: 'query_rag.py',
            queryTextSampleSize: 3,
        },
        passthrough: {
            enabled: true,
            fallbackCriticality: 'Important',
            fallbackDecision: 'Pending',
        },
        collectedFileFilter: (filename: string) =>
            filename.startsWith('MYSQ-') && filename.endsWith('.json'),
        preprocessedPatchMapper: (p: any) => ({
            issueId: p.patch_id,
            vendor: 'MySQL Community',
            component: p.component || 'mysql',
            version: p.version || '',
            osVersion: p.os_version || null,
            description: (p.description || '').slice(0, 4000),
            releaseDate: p.issued_date || null,
            url: p.ref_url || null,
        }),
        csvBOM: false,
        buildPrompt: (skillDir: string, batchSize: number, prunedBatch: any[]) =>
            `Read the rules explicitly from ${path.join(skillDir, 'SKILL.md')}. Evaluate the following ${batchSize} MySQL Community Oracle CPU patches according to the strict LLM evaluation rules in section 4 of that file.\nCRITICAL MANDATE: DO NOT USE ANY TOOLS TO READ OR SEARCH THE WORKSPACE JSON FILES. Do not parse patches_for_llm_review_mysql.json. IGNORE ANY PREVIOUS EXAMPLES or RAG retrievals. You must ONLY base your summary on the literal text provided below in [BATCH DATA].\nCRITICAL RULE FOR DESCRIPTIONS: The 'Description' and 'KoreanDescription' fields MUST be a concise, executive summary of the CVEs fixed. Emphasize remotely exploitable CVEs, the most critical sub-component affected, and the overall risk to MySQL deployments.\nReturn ONLY a pure JSON array with EXACTLY ${batchSize} objects. Each object MUST contain exactly: 'IssueID', 'Component', 'Version', 'Vendor', 'Date', 'Criticality', 'Description', 'KoreanDescription', and optionally 'Decision' and 'Reason'. For Vendor use 'MySQL Community'. For Component use 'mysql'. Do NOT skip evaluation steps.\n\n[BATCH DATA]:\n${JSON.stringify(prunedBatch)}`,
    },
];

// 활성 제품만 포함한 id → ProductConfig 맵. 워커에서 job.name으로 제품 설정을 빠르게 조회할 때 사용한다.
export const PRODUCT_MAP: Record<string, ProductConfig> = Object.fromEntries(
    PRODUCT_REGISTRY.filter(p => p.active).map(p => [p.id, p])
);

// 비활성 제품을 포함한 전체 레지스트리. 관리 UI나 검증 스크립트에서 전체 목록을 참조할 때 사용한다.
export const PRODUCT_REGISTRY_ALL = PRODUCT_REGISTRY;

// 제품 설정에서 절대 skillDir 경로를 계산한다.
// 서버의 HOME 디렉토리 아래 ~/.openclaw/workspace/skills/patch-review/{skillDirRelative} 형태.
export function getSkillDir(productCfg: ProductConfig): string {
    const baseDir = path.join(process.env.HOME || '/home/citec', '.openclaw/workspace/skills/patch-review');
    return path.join(baseDir, productCfg.skillDirRelative);
}
