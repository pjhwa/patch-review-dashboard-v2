import path from 'path';

export interface ProductConfig {
    id: string;
    name: string;
    vendorString: string;
    category: 'os' | 'storage' | 'database' | 'virtualization';
    active: boolean;
    skillDirRelative: string;
    dataSubDir: string;
    rawDataFilePrefix: string[];
    preprocessingScript: string;
    preprocessingArgs: string[];
    patchesForReviewFile: string;
    aiReportFile: string;
    finalCsvFile: string;
    jobName: string;
    rateLimitFlag: string;
    logTag: string;
    aiEntityName: string;
    aiVendorFieldValue: string;
    aiComponentDefault: string;
    aiVersionGrouped: boolean;
    aiBatchValidation: 'exact' | 'nonEmpty';
    ragExclusion?: {
        type: 'file-hiding' | 'prompt-injection';
        normalizedDirName?: string;
        queryScript?: string;
        queryTextSampleSize?: number;
    };
    passthrough: {
        enabled: boolean;
        fallbackCriticality: string;
        fallbackDecision: string;
    };
    collectedFileFilter: (filename: string) => boolean;
    preprocessedPatchMapper: (raw: any) => object;
    csvBOM: boolean;
    buildPrompt: (skillDir: string, batchSize: number, prunedBatch: any[]) => string;
}

export const PRODUCT_REGISTRY: ProductConfig[] = [
    {
        id: 'redhat',
        name: 'Red Hat Enterprise Linux',
        vendorString: 'Red Hat',
        category: 'os',
        active: true,
        skillDirRelative: 'os/linux-v2',
        dataSubDir: 'redhat_data',
        rawDataFilePrefix: ['RHSA-', 'RHBA-'],
        preprocessingScript: 'patch_preprocessing.py',
        preprocessingArgs: ['--vendor', 'redhat', '--days', '90'],
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
        }),
        csvBOM: false,
        buildPrompt: (skillDir: string, batchSize: number, prunedBatch: any[]) =>
            `Read the rules explicitly from ${path.join(skillDir, 'SKILL.md')}. Evaluate the following ${batchSize} PATCHES exactly according to the strict LLM evaluation rules detailed in section 4 of that file.\nCRITICAL MANDATE: IGNORE ANY PAST RETRIEVED MEMORIES OR PREVIOUS SUMMARIES. BASE ASSESSMENTS SOLELY ON THE [PATCH DATA] BELOW.\nDo NOT perform any web scraping. Do NOT use tools to write to files, simply output the text directly. Return ONLY a pure JSON array containing EXACTLY ${batchSize} objects. The object MUST contain exactly: 'IssueID', 'Component', 'Version', 'Vendor', 'Date', 'Criticality', 'Description', 'KoreanDescription', and optionally 'Decision' and 'Reason'. Do not skip Step 4.\\n\\n[BATCH DATA TO EVALUATE]:\\n${JSON.stringify(prunedBatch)}`,
    },
    {
        id: 'oracle',
        name: 'Oracle Linux',
        vendorString: 'Oracle',
        category: 'os',
        active: true,
        skillDirRelative: 'os/linux-v2',
        dataSubDir: 'oracle_data',
        rawDataFilePrefix: ['ELSA-'],
        preprocessingScript: 'patch_preprocessing.py',
        preprocessingArgs: ['--vendor', 'oracle', '--days', '90'],
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
        }),
        csvBOM: false,
        buildPrompt: (skillDir: string, batchSize: number, prunedBatch: any[]) =>
            `Read the rules explicitly from ${path.join(skillDir, 'SKILL.md')}. Evaluate the following ${batchSize} PATCHES exactly according to the strict LLM evaluation rules detailed in section 4 of that file.\nCRITICAL MANDATE: IGNORE ANY PAST RETRIEVED MEMORIES OR PREVIOUS SUMMARIES. BASE ASSESSMENTS SOLELY ON THE [PATCH DATA] BELOW.\nDo NOT perform any web scraping. Do NOT use tools to write to files, simply output the text directly. Return ONLY a pure JSON array containing EXACTLY ${batchSize} objects. The object MUST contain exactly: 'IssueID', 'Component', 'Version', 'Vendor', 'Date', 'Criticality', 'Description', 'KoreanDescription', and optionally 'Decision' and 'Reason'. Do not skip Step 4.\\n\\n[BATCH DATA TO EVALUATE]:\\n${JSON.stringify(prunedBatch)}`,
    },
    {
        id: 'ubuntu',
        name: 'Ubuntu Linux',
        vendorString: 'Ubuntu',
        category: 'os',
        active: true,
        skillDirRelative: 'os/linux-v2',
        dataSubDir: 'ubuntu_data',
        rawDataFilePrefix: ['USN-'],
        preprocessingScript: 'patch_preprocessing.py',
        preprocessingArgs: ['--vendor', 'ubuntu', '--days', '90'],
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
        }),
        csvBOM: false,
        buildPrompt: (skillDir: string, batchSize: number, prunedBatch: any[]) =>
            `Read the rules explicitly from ${path.join(skillDir, 'SKILL.md')}. Evaluate the following ${batchSize} PATCHES exactly according to the strict LLM evaluation rules detailed in section 4 of that file.\nCRITICAL MANDATE: IGNORE ANY PAST RETRIEVED MEMORIES OR PREVIOUS SUMMARIES. BASE ASSESSMENTS SOLELY ON THE [PATCH DATA] BELOW.\nDo NOT perform any web scraping. Do NOT use tools to write to files, simply output the text directly. Return ONLY a pure JSON array containing EXACTLY ${batchSize} objects. The object MUST contain exactly: 'IssueID', 'Component', 'Version', 'Vendor', 'Date', 'Criticality', 'Description', 'KoreanDescription', and optionally 'Decision' and 'Reason'. Do not skip Step 4.\\n\\n[BATCH DATA TO EVALUATE]:\\n${JSON.stringify(prunedBatch)}`,
    },
    {
        id: 'windows',
        name: 'Windows Server',
        vendorString: 'Windows Server',
        category: 'os',
        active: true,
        skillDirRelative: 'os/windows',
        dataSubDir: 'windows_data',
        rawDataFilePrefix: ['WIN-'],
        preprocessingScript: 'windows_preprocessing.py',
        preprocessingArgs: ['--days', '180', '--days_end', '90'],
        patchesForReviewFile: 'patches_for_llm_review_windows.json',
        aiReportFile: 'patch_review_ai_report_windows.json',
        finalCsvFile: 'final_approved_patches_windows.csv',
        jobName: 'run-windows-pipeline',
        rateLimitFlag: '/tmp/.rate_limit_windows',
        logTag: 'WINDOWS',
        aiEntityName: 'Windows Server VERSION GROUPS',
        aiVendorFieldValue: 'Windows Server',
        aiComponentDefault: 'cumulative-update',
        aiVersionGrouped: true,
        aiBatchValidation: 'nonEmpty',
        ragExclusion: {
            type: 'file-hiding',
            normalizedDirName: 'windows_data/normalized',
        },
        passthrough: {
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
        }),
        csvBOM: true,
        buildPrompt: (skillDir: string, batchSize: number, prunedBatch: any[]) =>
            `Read the rules explicitly from ${path.join(skillDir, 'SKILL.md')}. Evaluate the following ${batchSize} Windows Server VERSION GROUPS according to the strict LLM evaluation rules in section 4 of that file.\nCRITICAL MANDATE: DO NOT USE ANY TOOLS TO READ OR SEARCH THE WORKSPACE JSON FILES. Do not parse patches_for_llm_review_windows.json. IGNORE ANY PREVIOUS EXAMPLES or RAG retrievals. You must ONLY base your summary on the literal text provided below in [BATCH DATA].\nINPUT FORMAT: Each entry in [BATCH DATA] is a VERSION GROUP containing a 'patches' array of monthly cumulative updates for that Windows Server version. The group's patch_id is in the format 'WINDOWS-GROUP-<version>'.\nSELECTION RULE: For each VERSION GROUP, select the SINGLE MOST RECENT monthly patch (from the 'patches' array) that contains a fix for a critical security vulnerability or critical system stability issue. If no patch in the group meets critical criteria, EXCLUDE the entire group (set Decision to 'Exclude').\nOUTPUT RULE: Return EXACTLY ${batchSize} objects (one per input VERSION GROUP). IssueID = the GROUP's patch_id (e.g. 'WINDOWS-GROUP-Windows_Server_2025'). Version = the KB number of the SELECTED monthly patch (e.g. 'KB5058385'). OsVersion = the Windows Server version string.\nCRITICAL RULE FOR DESCRIPTIONS: The 'Description' and 'KoreanDescription' fields MUST be a concise 1-2 sentence executive summary of WHY the selected patch is critical. Focus on the specific critical vulnerability or stability issue fixed.\nEach object MUST contain exactly: 'IssueID', 'Component', 'Version', 'Vendor', 'OsVersion', 'Date', 'Criticality', 'Description', 'KoreanDescription', 'Decision', 'Reason'. For Vendor use 'Windows Server'. For Component use 'cumulative-update'.\n\n[BATCH DATA]:\n${JSON.stringify(prunedBatch)}`,
    },
    {
        id: 'ceph',
        name: 'Ceph',
        vendorString: 'Ceph',
        category: 'storage',
        active: true,
        skillDirRelative: 'storage/ceph',
        dataSubDir: 'ceph_data',
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
            type: 'file-hiding',
            normalizedDirName: 'ceph_data/normalized',
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
        dataSubDir: 'mariadb_data',
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
            type: 'file-hiding',
            normalizedDirName: 'mariadb_data/normalized',
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
        dataSubDir: 'sql_data',
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
            type: 'file-hiding',
            normalizedDirName: 'sql_data/normalized',
        },
        passthrough: {
            enabled: false,
            fallbackCriticality: 'Important',
            fallbackDecision: 'Pending',
        },
        collectedFileFilter: (filename: string) =>
            filename.startsWith('SQLU-') && filename.endsWith('.json'),
        preprocessedPatchMapper: (p: any) => ({
            issueId: p.id,
            vendor: 'SQL Server',
            component: p.component || 'SQL Server',
            version: p.version || '',
            osVersion: p.os_version || null,
            description: (p.summary || '').slice(0, 4000),
            releaseDate: p.date || null,
        }),
        csvBOM: true,
        buildPrompt: (skillDir: string, batchSize: number, prunedBatch: any[]) =>
            `Read the rules explicitly from ${path.join(skillDir, 'SKILL.md')}. Evaluate the following ${batchSize} Microsoft SQL Server VERSION GROUPS according to the strict LLM evaluation rules in section 4 of that file.\nCRITICAL MANDATE: DO NOT USE ANY TOOLS TO READ OR SEARCH THE WORKSPACE JSON FILES. Do not parse patches_for_llm_review_sqlserver.json. IGNORE ANY PREVIOUS EXAMPLES or RAG retrievals. You must ONLY base your summary on the literal text provided below in [BATCH DATA].\nINPUT FORMAT: Each entry in [BATCH DATA] is a VERSION GROUP containing a 'patches' array of monthly cumulative updates for that SQL Server version. The group's patch_id is in the format 'SQLS-GROUP-<version>'.\nSELECTION RULE: For each VERSION GROUP, select the SINGLE MOST RECENT monthly patch (from the 'patches' array) that contains a fix for a critical security vulnerability or critical system stability issue. If no patch in the group meets critical criteria, EXCLUDE the entire group (set Decision to 'Exclude').\nOUTPUT RULE: Return EXACTLY ${batchSize} objects (one per input VERSION GROUP). IssueID = the GROUP's patch_id (e.g. 'SQLS-GROUP-SQL_Server_2022'). Version = the CU number/KB of the SELECTED monthly patch. OsVersion = the SQL Server version string.\nCRITICAL RULE FOR DESCRIPTIONS: The 'Description' and 'KoreanDescription' fields MUST be a concise 1-2 sentence executive summary of WHY the selected patch is critical. Focus on the specific critical vulnerability or stability issue fixed.\nEach object MUST contain exactly: 'IssueID', 'Component', 'Version', 'Vendor', 'OsVersion', 'Date', 'Criticality', 'Description', 'KoreanDescription', 'Decision', 'Reason'. For Vendor use 'Microsoft'. For Component use 'SQL Server'.\n\n[BATCH DATA]:\n${JSON.stringify(prunedBatch)}`,
    },
    {
        id: 'pgsql',
        name: 'PostgreSQL',
        vendorString: 'PostgreSQL',
        category: 'database',
        active: true,
        skillDirRelative: 'database/pgsql',
        dataSubDir: 'pgsql_data',
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
            type: 'file-hiding',
            normalizedDirName: 'pgsql_data/normalized',
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
        dataSubDir: 'vsphere_data',
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
        }),
        csvBOM: false,
        buildPrompt: (skillDir: string, batchSize: number, prunedBatch: any[]) =>
            `Read the rules explicitly from ${path.join(skillDir, 'SKILL.md')}. Evaluate the following ${batchSize} VMware vSphere patches according to the strict LLM evaluation rules in section 4 of that file.\nCRITICAL MANDATE: DO NOT USE ANY TOOLS TO READ OR SEARCH THE WORKSPACE JSON FILES. Do not parse patches_for_llm_review_vsphere.json. IGNORE ANY PREVIOUS EXAMPLES or RAG retrievals. You must ONLY base your summary on the literal text provided below in [BATCH DATA].\nCRITICAL RULE FOR DESCRIPTIONS: The 'Description' and 'KoreanDescription' fields MUST be a concise, executive summary of the security advisories and bug fixes. DO NOT include verbatim file names or raw changelog copy-pastes. Describe WHAT was fixed and WHY it matters.\nReturn ONLY a pure JSON array with EXACTLY ${batchSize} objects. Each object MUST contain exactly: 'IssueID', 'Component', 'Version', 'Vendor', 'Date', 'Criticality', 'Description', 'KoreanDescription', and optionally 'Decision' and 'Reason'. For Vendor use 'VMware vSphere'. For Component use the specific product (e.g. 'ESXi', 'vCenter Server'). Do NOT skip evaluation steps.\n\n[BATCH DATA]:\n${JSON.stringify(prunedBatch)}`,
    },
    // Inactive placeholder products
    {
        id: 'mysql',
        name: 'MySQL',
        vendorString: 'MySQL',
        category: 'database',
        active: false,
        skillDirRelative: 'database/mysql',
        dataSubDir: 'mysql_data',
        rawDataFilePrefix: [],
        preprocessingScript: 'mysql_preprocessing.py',
        preprocessingArgs: ['--days', '180'],
        patchesForReviewFile: 'patches_for_llm_review_mysql.json',
        aiReportFile: 'patch_review_ai_report_mysql.json',
        finalCsvFile: 'final_approved_patches_mysql.csv',
        jobName: 'run-mysql-pipeline',
        rateLimitFlag: '/tmp/.rate_limit_mysql',
        logTag: 'MYSQL',
        aiEntityName: 'MySQL patches',
        aiVendorFieldValue: 'MySQL',
        aiComponentDefault: 'mysql',
        aiVersionGrouped: false,
        aiBatchValidation: 'exact',
        passthrough: {
            enabled: true,
            fallbackCriticality: 'Important',
            fallbackDecision: 'Pending',
        },
        collectedFileFilter: (filename: string) => filename.endsWith('.json'),
        preprocessedPatchMapper: (p: any) => ({
            issueId: p.patch_id,
            vendor: 'MySQL',
            component: p.component || 'mysql',
            version: p.version || '',
            osVersion: p.os_version || null,
            description: (p.description || '').slice(0, 4000),
            releaseDate: p.issued_date || null,
        }),
        csvBOM: false,
        buildPrompt: (skillDir: string, batchSize: number, prunedBatch: any[]) =>
            `Evaluate the following ${batchSize} MySQL patches.\n\n[BATCH DATA]:\n${JSON.stringify(prunedBatch)}`,
    },
    {
        id: 'mongodb',
        name: 'MongoDB',
        vendorString: 'MongoDB',
        category: 'database',
        active: false,
        skillDirRelative: 'database/mongodb',
        dataSubDir: 'mongodb_data',
        rawDataFilePrefix: [],
        preprocessingScript: 'mongodb_preprocessing.py',
        preprocessingArgs: ['--days', '180'],
        patchesForReviewFile: 'patches_for_llm_review_mongodb.json',
        aiReportFile: 'patch_review_ai_report_mongodb.json',
        finalCsvFile: 'final_approved_patches_mongodb.csv',
        jobName: 'run-mongodb-pipeline',
        rateLimitFlag: '/tmp/.rate_limit_mongodb',
        logTag: 'MONGODB',
        aiEntityName: 'MongoDB patches',
        aiVendorFieldValue: 'MongoDB',
        aiComponentDefault: 'mongodb',
        aiVersionGrouped: false,
        aiBatchValidation: 'exact',
        passthrough: {
            enabled: true,
            fallbackCriticality: 'Important',
            fallbackDecision: 'Pending',
        },
        collectedFileFilter: (filename: string) => filename.endsWith('.json'),
        preprocessedPatchMapper: (p: any) => ({
            issueId: p.patch_id,
            vendor: 'MongoDB',
            component: p.component || 'mongodb',
            version: p.version || '',
            osVersion: p.os_version || null,
            description: (p.description || '').slice(0, 4000),
            releaseDate: p.issued_date || null,
        }),
        csvBOM: false,
        buildPrompt: (skillDir: string, batchSize: number, prunedBatch: any[]) =>
            `Evaluate the following ${batchSize} MongoDB patches.\n\n[BATCH DATA]:\n${JSON.stringify(prunedBatch)}`,
    },
];

export const PRODUCT_MAP: Record<string, ProductConfig> = Object.fromEntries(
    PRODUCT_REGISTRY.filter(p => p.active).map(p => [p.id, p])
);

export const PRODUCT_REGISTRY_ALL = PRODUCT_REGISTRY;

export function getSkillDir(productCfg: ProductConfig): string {
    const baseDir = path.join(process.env.HOME || '/home/citec', '.openclaw/workspace/skills/patch-review');
    return path.join(baseDir, productCfg.skillDirRelative);
}
