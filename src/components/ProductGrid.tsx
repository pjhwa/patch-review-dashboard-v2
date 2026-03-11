"use client"

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { PremiumCard } from "@/components/PremiumCard";

export function ProductGrid({ categoryId, products, dict }: { categoryId: string, products: any[], dict: any }) {
    const [isRunning, setIsRunning] = useState(false);
    const [resultMsg, setResultMsg] = useState("");
    const [logTail, setLogTail] = useState("");
    const [lastCompletedAt, setLastCompletedAt] = useState<string | null>(null);
    const [failureCount, setFailureCount] = useState<number>(0);
    const [confirmDialog, setConfirmDialog] = useState<{ isOpen: boolean, productId: string | null, isRetry: boolean, isAiOnly: boolean }>({ isOpen: false, productId: null, isRetry: false, isAiOnly: false });
    const [isDownloading, setIsDownloading] = useState(false);
    const [isQueueing, setIsQueueing] = useState(false);
    const router = useRouter();

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
        setIsRunning(true);
        setResultMsg(dict?.dashboard?.productGrid?.initiatingPipeline || "Initiating Pipeline Queue...");
        setLogTail("");

        try {
            const res = await fetch('/api/pipeline/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ providers: [productId === 'windows' || productId === 'solaris' ? 'rhel' : productId], isRetry, isAiOnly })
            });

            const data = await res.json();
            if (!res.ok || !data.jobId) {
                setResultMsg(data.error || "Execution failed to queue.");
                setIsRunning(false);
                return;
            }

            // Open Server-Sent Events stream to the job
            const eventSource = new EventSource(`/api/pipeline/stream?jobId=${data.jobId}`);

            eventSource.onmessage = (event) => {
                const streamData = JSON.parse(event.data);

                if (streamData.status === 'completed') {
                    setResultMsg("Pipeline successfully finished!");
                    setIsRunning(false);
                    setIsQueueing(false);
                    eventSource.close();
                    router.refresh();
                } else if (streamData.status === 'failed' || streamData.status === 'error') {
                    const errMsg = streamData.message || streamData.log || "Unknown error";
                    setResultMsg(`❌ Pipeline Failed: ${errMsg}`);
                    if (streamData.message) setLogTail(prev => prev + "\n" + streamData.message);
                    setIsRunning(false);
                    setIsQueueing(false);
                    eventSource.close();
                } else {
                    if (streamData.log) {
                        // Detect preprocessing completion → refresh stats immediately
                        if (streamData.log.includes('[PREPROCESS_DONE]')) {
                            const match = streamData.log.match(/count=(\d+)/);
                            const cnt = match ? match[1] : '?';
                            setResultMsg(`✅ 전처리 완료 (${cnt}개 패치). AI 리뷰 진행 중...`);
                            router.refresh(); // updates the preprocessed count on cards
                        }
                        setLogTail(prev => {
                            const newLogs = prev.split('\n');
                            newLogs.push(streamData.log);
                            if (newLogs.length > 30) newLogs.shift();
                            return newLogs.join('\n');
                        });
                    }
                    if (streamData.message && !streamData.log?.includes('[PREPROCESS_DONE]')) {
                        setResultMsg(streamData.message);
                    } else if (!streamData.log?.includes('[PREPROCESS_DONE]')) {
                        if (streamData.status === 'active') {
                            setResultMsg(`Pipeline active (Progress: ${streamData.progress || 0}%)`);
                        } else if (streamData.status === 'waiting') {
                            setResultMsg(`Job queued... Waiting for worker...`);
                        }
                    }
                }
            };

            eventSource.onerror = (error) => {
                console.error("SSE Error:", error);
                setResultMsg("Lost connection to pipeline stream.");
                setIsRunning(false);
                setIsQueueing(false);
                eventSource.close();
            };

        } catch (error) {
            setResultMsg("Failed to connect to execution queue.");
            setIsRunning(false);
            setIsQueueing(false);
        }
    };

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
                alert("No finalized CSV available to download yet. Please ensure the review is marked as complete.");
            }
        } catch (e) {
            console.error("Failed to download CSV", e);
            alert("Error downloading CSV.");
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
                        isRunning={isRunning && prod.active}
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
                            {!isRunning && lastCompletedAt && (
                                <p className="text-xs text-emerald-500/80 mt-1">{dict?.dashboard?.productGrid?.lastRun || "Last Run: "}{new Date(lastCompletedAt).toLocaleString()}</p>
                            )}
                        </div>
                        {!isRunning && failureCount > 0 && (
                            <button
                                onClick={() => requestRunPipeline('ubuntu', true)}
                                className="px-3 py-1 bg-emerald-500/20 hover:bg-emerald-500/40 border border-emerald-500/40 text-emerald-100 text-xs rounded transition-colors"
                            >
                                {dict?.dashboard?.productGrid?.retryFailed || "Retry Failed"} ({failureCount})
                            </button>
                        )}
                        {!isRunning && lastCompletedAt && (
                            <button
                                onClick={handleDownloadCSV}
                                disabled={isDownloading}
                                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg transition-colors ml-4 shadow-[0_0_15px_rgba(59,130,246,0.5)] disabled:opacity-50 flex items-center gap-2 border border-blue-500"
                            >
                                {isDownloading ? (dict?.dashboard?.productGrid?.generating || "Generating...") : (dict?.dashboard?.productGrid?.downloadCsvBtn || "Download Final CSR")}
                            </button>
                        )}
                    </div>
                    {logTail && (
                        <div className="mt-2 p-3 bg-black/40 rounded border border-white/5 font-mono text-xs text-white/60 whitespace-pre-wrap leading-tight overflow-x-auto max-h-64 overflow-y-auto">
                            {logTail}
                        </div>
                    )}
                </div>
            )}

            {confirmDialog.isOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
                    <div className="bg-[#111] border border-white/10 rounded-xl p-6 max-w-md w-full shadow-2xl">
                        <h3 className="text-lg font-medium text-white mb-4">
                            {confirmDialog.isAiOnly ? (dict?.dashboard?.productGrid?.aiOnlyTitle || "Run AI Analysis Only") : (confirmDialog.isRetry ? (dict?.dashboard?.productGrid?.retryTitle || "Retry Failed Collection") : (dict?.dashboard?.productGrid?.startCollectionTitle || "Run Full Pipeline"))}
                        </h3>

                        <div className="text-sm text-white/60 space-y-4 mb-6">
                            {!confirmDialog.isRetry && !confirmDialog.isAiOnly && lastCompletedAt && (
                                <div className="p-3 bg-red-500/10 border border-red-500/20 rounded text-red-400">
                                    <strong className="block mb-1">{dict?.dashboard?.productGrid?.recentExecutionDetected || "최근 실행 기록이 존재합니다."}</strong>
                                    마지막 실행 시간: {new Date(lastCompletedAt).toLocaleString()}. 새로 실행하면 현재의 진행 상태(Preprocessed, AI Reviewed 카운트)가 `0`으로 초기화됩니다.
                                </div>
                            )}

                            {confirmDialog.isAiOnly ? (
                                <p>이미 전처리된 패치 목록을 바탕으로 AI 리뷰만 단독으로 재수행합니다.</p>
                            ) : (!confirmDialog.isRetry ? (
                                <p>데이터 수집(Data Collection)은 이제 백그라운드 리눅스 Cron 작업으로 별도 수행됩니다.<br />파이프라인을 실행하면 **수집되어 있는 파일들을 바탕으로 전처리 작업부터 AI 리뷰까지 새로 진행**합니다.</p>
                            ) : (
                                <p>과거 실패했던 파이프라인 단계를 다시 재시도합니다.</p>
                            ))}
                            <p className="font-medium text-white/80">정말로 파이프라인 진행을 시작하시겠습니까?</p>
                        </div>

                        <div className="flex justify-end gap-3">
                            <button
                                onClick={() => !isQueueing && setConfirmDialog({ isOpen: false, productId: null, isRetry: false, isAiOnly: false })}
                                disabled={isQueueing}
                                className="px-4 py-2 rounded bg-white/5 hover:bg-white/10 text-white transition-colors text-sm disabled:opacity-50"
                            >
                                {dict?.dashboard?.productGrid?.cancelBtn || "Cancel"}
                            </button>
                            <button
                                onClick={confirmRun}
                                disabled={isQueueing}
                                className="px-4 py-2 rounded bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 border border-emerald-500/30 transition-colors text-sm font-medium disabled:opacity-50"
                            >
                                {isQueueing ? "Queueing..." : confirmDialog.isAiOnly ? (dict?.dashboard?.productGrid?.yesAiOnlyBtn || "Yes, AI Only") : (confirmDialog.isRetry ? (dict?.dashboard?.productGrid?.yesRetryBtn || "Retry") : (dict?.dashboard?.productGrid?.yesStartFreshBtn || "Yes, Queue Job"))}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
