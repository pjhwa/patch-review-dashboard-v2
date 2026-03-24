"use client"

// 카테고리 페이지의 제품 목록 및 파이프라인 실행 컨트롤 컴포넌트.
// SSE(Server-Sent Events)로 파이프라인 로그를 실시간 스트리밍하며,
// 실행 확인 다이얼로그를 통해 Fresh Start / AI Only / Retry 3가지 모드를 지원한다.
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { PremiumCard } from "@/components/PremiumCard";

export function ProductGrid({ categoryId, products, dict }: { categoryId: string, products: any[], dict: any }) {
    const [runningProductId, setRunningProductId] = useState<string | null>(null);
    const [resultMsg, setResultMsg] = useState("");
    const [logTail, setLogTail] = useState("");
    const [lastCompletedAt, setLastCompletedAt] = useState<string | null>(null);
    const [failureCount, setFailureCount] = useState<number>(0);
    const [confirmDialog, setConfirmDialog] = useState<{ isOpen: boolean, productId: string | null, isRetry: boolean, isAiOnly: boolean }>({ isOpen: false, productId: null, isRetry: false, isAiOnly: false });
    const [isDownloading, setIsDownloading] = useState(false);
    const [isQueueing, setIsQueueing] = useState(false);
    const [activeEventSource, setActiveEventSource] = useState<EventSource | null>(null);
    const router = useRouter();

    // 컴포넌트 언마운트 시 열려있는 SSE 연결을 닫아 메모리 누수를 방지한다.
    useEffect(() => {
        return () => {
            if (activeEventSource) {
                activeEventSource.close();
            }
        };
    }, [activeEventSource]);

    // 페이지 최초 로드 시 이미 실행 중인 파이프라인 잡이 있으면 SSE 스트림에 자동으로 재연결한다.
    // 사용자가 페이지를 새로고침해도 진행 상황을 계속 볼 수 있다.
    useEffect(() => {
        const checkActiveJob = async () => {
            try {
                const res = await fetch('/api/pipeline');
                const data = await res.json();
                if (data.hasActiveJob && data.jobId) {
                    setRunningProductId(data.provider || null);
                    setResultMsg((dict?.dashboard?.productGrid?.pipelineActiveMsg || "Pipeline active (Progress: {progress}%)").replace('{progress}', String(data.progress || 0)));
                    connectToStream(data.jobId);
                }
            } catch (e) {
                console.error("Failed to check active job", e);
            }
        };
        checkActiveJob();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // SSE(Server-Sent Events) 스트림에 연결하고, 수신한 로그를 파싱해 UI 상태를 갱신한다.
    // 로그 태그(PREPROCESS_DONE, RESUME, SKIP-RESUME 등)를 감지해 사용자 친화적인 메시지로 변환한다.
    // 로그 버퍼(logTail)는 최근 30줄로 제한해 화면이 너무 길어지는 것을 방지한다.
    const connectToStream = (jobId: string) => {
        const source = new EventSource(`/api/pipeline/stream?jobId=${jobId}`);
        setActiveEventSource(source);

        source.onmessage = (event) => {
            const streamData = JSON.parse(event.data);

            if (streamData.log) {
                // OS pipeline keywords
                // Generic PREPROCESS_DONE handler — matches [REDHAT-PREPROCESS_DONE], [ORACLE-PREPROCESS_DONE], [UBUNTU-PREPROCESS_DONE], [CEPH-PREPROCESS_DONE] etc.
                if (streamData.log.includes('PREPROCESS_DONE')) {
                    const match = streamData.log.match(/count=(\d+)/);
                    const cnt = match ? match[1] : null;
                    // Derive product name from log tag (e.g. [REDHAT-PREPROCESS_DONE] → "REDHAT")
                    const tagMatch = streamData.log.match(/\[(\w+)-PREPROCESS_DONE\]/);
                    const tagName = tagMatch ? tagMatch[1] : null;
                    const productLabel: Record<string, string> = {
                        REDHAT: 'Red Hat', ORACLE: 'Oracle Linux', UBUNTU: 'Ubuntu',
                        CEPH: 'Ceph', MARIADB: 'MariaDB', WINDOWS: 'Windows Server',
                        SQLSERVER: 'SQL Server', VSPHERE: 'VMware vSphere', PGSQL: 'PostgreSQL',
                    };
                    const label = (tagName && productLabel[tagName]) ? productLabel[tagName] : (dict?.dashboard?.productGrid?.preprocessLabel || 'Preprocessing');
                    const doneMsg = cnt
                        ? (dict?.dashboard?.productGrid?.preprocessDoneWithCount || "✅ {label} Preprocessing Complete ({count} patches). AI Review in progress...").replace('{label}', label).replace('{count}', cnt)
                        : (dict?.dashboard?.productGrid?.preprocessDone || "✅ {label} Preprocessing Complete. AI Review in progress...").replace('{label}', label);
                    setResultMsg(doneMsg);
                    router.refresh();
                } else if (streamData.log.includes('[RESUME]')) {
                    setResultMsg(`🔁 ${streamData.log.replace(/\[\w+-RESUME\]|\[RESUME\]/, '').trim()}`);
                } else if (streamData.log.includes('[SKIP-RESUME]')) {
                    setResultMsg(`⏭️ ${streamData.log.replace(/\[\w+-SKIP-RESUME\]|\[SKIP-RESUME\]/, '').trim()}`);
                // Generic pipeline progress — matches [REDHAT-PIPELINE], [REDHAT-AI Analysis], [CEPH-PIPELINE] etc.
                } else if (streamData.log.match(/\[\w+-PIPELINE\]|\[\w+-AI Analysis\]|\[\w+-AI\]/)) {
                    setResultMsg(`🤖 ${streamData.log}`);
                } else if (streamData.log.includes('[AI Analysis]') || streamData.log.includes('[SKIP]')) {
                    setResultMsg(`🤖 ${streamData.log}`);
                } else if (streamData.log.includes('All tasks completed successfully')) {
                    setResultMsg(dict?.dashboard?.productGrid?.pipelineAllDone || '✅ All Pipeline Tasks Complete!');
                }
                setLogTail(prev => {
                    const newLogs = prev.split('\n');
                    newLogs.push(streamData.log);
                    if (newLogs.length > 30) newLogs.shift();
                    return newLogs.join('\n');
                });
            }

            if (streamData.status === 'completed') {
                setResultMsg(dict?.dashboard?.productGrid?.pipelineFinished || "Pipeline successfully finished!");
                setRunningProductId(null);
                setIsQueueing(false);
                source.close();
                setActiveEventSource(null);
                router.refresh();
            } else if (streamData.status === 'failed' || streamData.status === 'error') {
                const errMsg = streamData.message || streamData.log || "Unknown error";
                setResultMsg(`${dict?.dashboard?.productGrid?.pipelineFailed || "❌ Pipeline Failed: "}${errMsg}`);
                if (streamData.message) setLogTail(prev => prev + "\n" + streamData.message);
                setRunningProductId(null);
                setIsQueueing(false);
                source.close();
                setActiveEventSource(null);
            } else {
                if (streamData.message && !streamData.log?.includes('PREPROCESS_DONE')) {
                    setResultMsg(streamData.message);
                } else if (!streamData.log) {
                    if (streamData.status === 'active') {
                        setResultMsg((dict?.dashboard?.productGrid?.pipelineActiveMsg || "Pipeline active (Progress: {progress}%)").replace('{progress}', String(streamData.progress || 0)));
                    } else if (streamData.status === 'waiting') {
                        setResultMsg(dict?.dashboard?.productGrid?.jobQueued || "Job queued... Waiting for worker...");
                    }
                }
            }
        };

        source.onerror = (error) => {
            console.error("SSE Error:", error);
            setResultMsg(dict?.dashboard?.productGrid?.connectionLost || "Lost connection to pipeline stream.");
            setRunningProductId(null);
            setIsQueueing(false);
            source.close();
            setActiveEventSource(null);
        };
    };

    const requestRunPipeline = (productId: string, isRetry: boolean = false, isAiOnly: boolean = false) => {
        setConfirmDialog({ isOpen: true, productId, isRetry, isAiOnly });
    };

    const confirmRun = () => {
        if (confirmDialog.productId) {
            handleRunSharedPipeline(confirmDialog.productId, confirmDialog.isRetry, confirmDialog.isAiOnly);
        }
        setConfirmDialog({ isOpen: false, productId: null, isRetry: false, isAiOnly: false });
    };

    const handleRunSharedPipeline = async (productId: string, isRetry: boolean = false, isAiOnly: boolean = false) => {
        if (isQueueing) return;
        setIsQueueing(true);
        setRunningProductId(productId);
        setResultMsg(dict?.dashboard?.productGrid?.initiatingPipeline || "Initiating Pipeline Queue...");
        setLogTail("");

        // 카테고리 및 제품 ID에 따라 파이프라인 실행 엔드포인트를 결정한다.
        // 각 제품은 독립적인 API 라우트를 가지며, 전달하는 body 구조도 다를 수 있다.
        let pipelineRunUrl = '/api/pipeline/run';
        if (categoryId === 'storage') pipelineRunUrl = '/api/pipeline/ceph/run';
        else if (categoryId === 'database') {
            if (productId === 'sqlserver') pipelineRunUrl = '/api/pipeline/sqlserver/run';
            else if (productId === 'pgsql') pipelineRunUrl = '/api/pipeline/pgsql/run';
            else if (productId === 'mysql') pipelineRunUrl = '/api/pipeline/mysql/run';
            else pipelineRunUrl = '/api/pipeline/mariadb/run';
        }
        else if (productId === 'windows') pipelineRunUrl = '/api/pipeline/windows/run';
        else if (categoryId === 'virtualization') pipelineRunUrl = '/api/pipeline/vsphere/run';
        else if (categoryId === 'middleware') {
            if (productId === 'tomcat') pipelineRunUrl = '/api/pipeline/tomcat/run';
            else if (productId === 'wildfly') pipelineRunUrl = '/api/pipeline/wildfly/run';
            else pipelineRunUrl = '/api/pipeline/jboss_eap/run';
        }

        // middleware 제품은 body에 providers 배열 불필요 (각 run route가 productId 고정)
        const isSimpleBody = categoryId === 'storage' || categoryId === 'virtualization' || categoryId === 'middleware';

        try {
            const res = await fetch(pipelineRunUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(
                    isSimpleBody
                        ? { isRetry, isAiOnly }
                        : { providers: [productId], isRetry, isAiOnly }
                )
            });

            const data = await res.json();
            if (!res.ok || !data.jobId) {
                setResultMsg(data.error || dict?.dashboard?.productGrid?.executionFailed || "Execution failed to queue.");
                setRunningProductId(null);
                return;
            }

            connectToStream(data.jobId);

        } catch (error) {
            setResultMsg(dict?.dashboard?.productGrid?.connectionFailed || "Failed to connect to execution queue.");
            setRunningProductId(null);
            setIsQueueing(false);
        }
    };

    // 카테고리 내 모든 제품의 최종 승인 CSV를 병합해 다운로드한다.
    // Blob URL을 동적으로 생성해 링크 클릭으로 즉시 다운로드를 트리거한다.
    const handleDownloadCSV = async () => {
        setIsDownloading(true);
        try {
            // Fetch without productId to merge all finalized CSVs for the category
            const res = await fetch(`/api/pipeline/export?categoryId=${categoryId}`);
            if (res.ok) {
                const blob = await res.blob();
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.style.display = 'none';
                a.href = url;
                a.download = `Final_Approved_Patches_${categoryId}_${new Date().toISOString().split('T')[0]}.csv`;
                document.body.appendChild(a);
                a.click();
                window.URL.revokeObjectURL(url);
            } else {
                alert(dict?.dashboard?.productGrid?.noCSVAvailable || "No finalized CSV available to download yet. Please ensure the review is marked as complete.");
            }
        } catch (e) {
            console.error("Failed to download CSV", e);
            alert(dict?.dashboard?.productGrid?.csvDownloadError || "Error downloading CSV.");
        } finally {
            setIsDownloading(false);
        }
    };

    return (
        <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 pt-4">
                {products.map((prod: any) => (
                    <PremiumCard
                        key={prod.id}
                        title={prod.name}
                        stages={prod.stages}
                        desc={dict?.dashboard?.productGrid?.pendingPatches || "Patches awaiting AI Review"}
                        active={prod.active}
                        href={`/category/${categoryId}/${prod.id}`}
                        categoryId={categoryId}
                        productId={prod.id}
                        isRunning={runningProductId === prod.id}
                        isReviewCompleted={prod.isReviewCompleted}
                        onRunPipeline={() => requestRunPipeline(prod.id, false, false)}
                        onRunAiOnly={() => requestRunPipeline(prod.id, false, true)}
                        dict={dict}
                    />
                ))}
            </div>

            {(resultMsg || failureCount > 0 || logTail) && (
                <div className="p-4 border border-emerald-500/20 bg-emerald-500/10 rounded-lg">
                    <div className="flex justify-between items-center">
                        <div className="flex-col">
                            <p className="text-sm text-emerald-400 font-medium">{resultMsg || dict?.dashboard?.productGrid?.idlePipeline || "Idle"}</p>
                            {!runningProductId && lastCompletedAt && (
                                <p className="text-xs text-emerald-500/80 mt-1">{dict?.dashboard?.productGrid?.lastRun || "Last Run: "}{new Date(lastCompletedAt).toLocaleString()}</p>
                            )}
                        </div>
                        {!runningProductId && failureCount > 0 && (
                            <button
                                onClick={() => requestRunPipeline('ubuntu', true)}
                                className="px-3 py-1 bg-emerald-500/20 hover:bg-emerald-500/40 border border-emerald-500/40 text-emerald-100 text-xs rounded transition-colors"
                            >
                                {dict?.dashboard?.productGrid?.retryFailed || "Retry Failed"} ({failureCount})
                            </button>
                        )}
                        {!runningProductId && lastCompletedAt && (
                            <button
                                onClick={handleDownloadCSV}
                                disabled={isDownloading}
                                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-foreground text-xs font-semibold rounded-lg transition-colors ml-4 shadow-[0_0_15px_rgba(59,130,246,0.5)] disabled:opacity-50 flex items-center gap-2 border border-blue-500"
                            >
                                {isDownloading ? (dict?.dashboard?.productGrid?.generating || "Generating...") : (dict?.dashboard?.productGrid?.downloadCsvBtn || "Download Final CSR")}
                            </button>
                        )}
                    </div>
                    {logTail && (
                        <div className="mt-2 p-3 bg-foreground/[0.04] rounded border border-foreground/5 font-mono text-xs text-foreground/60 whitespace-pre-wrap leading-tight overflow-x-auto max-h-64 overflow-y-auto">
                            {logTail}
                        </div>
                    )}
                </div>
            )}

            {confirmDialog.isOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-foreground/60 backdrop-blur-sm">
                    <div className="bg-card border border-foreground/10 rounded-xl p-6 max-w-md w-full shadow-2xl">
                        <h3 className="text-lg font-medium text-foreground mb-4">
                            {confirmDialog.isAiOnly ? (dict?.dashboard?.productGrid?.aiOnlyTitle || "Run AI Analysis Only") : (confirmDialog.isRetry ? (dict?.dashboard?.productGrid?.retryTitle || "Retry Failed Collection") : (dict?.dashboard?.productGrid?.startCollectionTitle || "Run Full Pipeline"))}
                        </h3>

                        <div className="text-sm text-foreground/60 space-y-4 mb-6">
                            {!confirmDialog.isRetry && !confirmDialog.isAiOnly && lastCompletedAt && (
                                <div className="p-3 bg-red-500/10 border border-red-500/20 rounded text-red-400">
                                    <strong className="block mb-1">{dict?.dashboard?.productGrid?.recentExecutionDetected || "Recent Execution Detected!"}</strong>
                                    {(dict?.dashboard?.productGrid?.recentExecutionWarning || "Last run time: {time}. Running again will reset the current pipeline progress (Preprocessed, AI Reviewed counts) to 0.").replace('{time}', new Date(lastCompletedAt).toLocaleString())}
                                </div>
                            )}

                            {confirmDialog.isAiOnly ? (
                                <p>{dict?.dashboard?.productGrid?.aiOnlyDesc || "Runs only the LLM Impact Analysis using existing preprocessed patches."}</p>
                            ) : (!confirmDialog.isRetry ? (
                                <p>{dict?.dashboard?.productGrid?.freshStartDesc || "Running the pipeline will perform preprocessing and AI review from scratch based on currently collected files."}</p>
                            ) : (
                                <p>{dict?.dashboard?.productGrid?.retryDesc || "Retries the previously failed pipeline stages."}</p>
                            ))}
                            <p className="font-medium text-foreground/80">{dict?.dashboard?.productGrid?.proceedAsk || "Do you wish to proceed?"}</p>
                        </div>

                        <div className="flex justify-end gap-3">
                            <button
                                onClick={() => !isQueueing && setConfirmDialog({ isOpen: false, productId: null, isRetry: false, isAiOnly: false })}
                                disabled={isQueueing}
                                className="px-4 py-2 rounded bg-foreground/5 hover:bg-foreground/10 text-foreground transition-colors text-sm disabled:opacity-50"
                            >
                                {dict?.dashboard?.productGrid?.cancelBtn || "Cancel"}
                            </button>
                            <button
                                onClick={confirmRun}
                                disabled={isQueueing}
                                className="px-4 py-2 rounded bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 border border-emerald-500/30 transition-colors text-sm font-medium disabled:opacity-50"
                            >
                                {isQueueing ? (dict?.dashboard?.productGrid?.queueing || "Queueing...") : confirmDialog.isAiOnly ? (dict?.dashboard?.productGrid?.yesAiOnlyBtn || "Yes, AI Only") : (confirmDialog.isRetry ? (dict?.dashboard?.productGrid?.yesRetryBtn || "Retry") : (dict?.dashboard?.productGrid?.yesStartFreshBtn || "Yes, Queue Job"))}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
