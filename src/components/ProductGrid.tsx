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
                    eventSource.close();
                    router.refresh();
                } else if (streamData.status === 'failed' || streamData.status === 'error') {
                    setResultMsg("Pipeline Failed.");
                    if (streamData.message) setLogTail(prev => prev + "\n" + streamData.message);
                    setIsRunning(false);
                    eventSource.close();
                } else {
                    if (streamData.log) {
                        setLogTail(prev => {
                            const newLogs = prev.split('\n');
                            newLogs.push(streamData.log);
                            if (newLogs.length > 30) newLogs.shift(); // Keep last 30 lines
                            return newLogs.join('\n');
                        });
                    }
                    if (streamData.message) {
                        setResultMsg(streamData.message);
                    } else if (streamData.status === 'active') {
                        setResultMsg(`Pipeline active (Progress: ${streamData.progress || 0}%)`);
                    } else if (streamData.status === 'waiting') {
                        setResultMsg(`Job queued... Waiting for worker...`);
                    }
                }
            };

            eventSource.onerror = (error) => {
                console.error("SSE Error:", error);
                setResultMsg("Lost connection to pipeline stream.");
                setIsRunning(false);
                eventSource.close();
            };

        } catch (error) {
            setResultMsg("Failed to connect to execution queue.");
            setIsRunning(false);
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
                                    <strong className="block mb-1">{dict?.dashboard?.productGrid?.recentExecutionDetected || "Recent Execution Detected"}</strong>
                                    {dict?.dashboard?.productGrid?.recentExecutionDesc || "The pipeline was run recently at: "}{new Date(lastCompletedAt).toLocaleString()}. {dict?.dashboard?.productGrid?.recentExecutionAsk || "A fresh run will reset current progress."}
                                </div>
                            )}

                            {confirmDialog.isAiOnly ? (
                                <p>{dict?.dashboard?.productGrid?.aiOnlyDesc || "AI Only Execution."}</p>
                            ) : (!confirmDialog.isRetry ? (
                                <p>{dict?.dashboard?.productGrid?.freshStartDesc || "Executing full pipeline via BullMQ Queue..."}</p>
                            ) : (
                                <p>{dict?.dashboard?.productGrid?.retryDesc || "Retrying."}</p>
                            ))}
                            <p className="font-medium text-white/80">{dict?.dashboard?.productGrid?.proceedAsk || "Proceed?"}</p>
                        </div>

                        <div className="flex justify-end gap-3">
                            <button
                                onClick={() => setConfirmDialog({ isOpen: false, productId: null, isRetry: false, isAiOnly: false })}
                                className="px-4 py-2 rounded bg-white/5 hover:bg-white/10 text-white transition-colors text-sm"
                            >
                                {dict?.dashboard?.productGrid?.cancelBtn || "Cancel"}
                            </button>
                            <button
                                onClick={confirmRun}
                                className="px-4 py-2 rounded bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 border border-emerald-500/30 transition-colors text-sm font-medium"
                            >
                                {confirmDialog.isAiOnly ? (dict?.dashboard?.productGrid?.yesAiOnlyBtn || "Yes, AI Only") : (confirmDialog.isRetry ? (dict?.dashboard?.productGrid?.yesRetryBtn || "Retry") : (dict?.dashboard?.productGrid?.yesStartFreshBtn || "Yes, Queue Job"))}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
