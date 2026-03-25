"use client"
import { useState, useEffect, useMemo } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, ArrowLeft, CheckCircle2, AlertTriangle, Info, BrainCircuit, Search } from "lucide-react";
import Link from 'next/link';

export function ProductDetailClient({ categoryId, productId, dict }: { categoryId: string, productId: string, dict: any }) {
    const [preprocessedData, setPreprocessedData] = useState<any>(null);
    const [reviewedData, setReviewedData] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [feedbacks, setFeedbacks] = useState<any[]>([]);
    const [localExclusions, setLocalExclusions] = useState<Record<string, { excluded: boolean, reason: string, category?: string, detail?: string }>>({});
    const [savingId, setSavingId] = useState<string | null>(null);
    const [isFinalizing, setIsFinalizing] = useState(false);
    const [finalizeSuccess, setFinalizeSuccess] = useState(false);
    const [isDone, setIsDone] = useState(false);
    const [preprocessedSearchQuery, setPreprocessedSearchQuery] = useState("");
    const [manualReviewRequests, setManualReviewRequests] = useState<Record<string, boolean>>({});
    const [isManualReviewing, setIsManualReviewing] = useState(false);
    const [manualReviewStatus, setManualReviewStatus] = useState<'idle' | 'done' | 'error'>('idle');

    useEffect(() => {
        const fetchData = async () => {
            setLoading(true);
            try {
                const [pRes, rRes, fRes] = await Promise.all([
                    fetch(`/api/pipeline/stage/preprocessed?product=${productId}`),
                    fetch(`/api/pipeline/stage/reviewed?product=${productId}`),
                    fetch(`/api/pipeline/feedback`)
                ]);

                const pJson = await pRes.json();
                setPreprocessedData(pJson);

                // Initialize manual review selections from DB isAiReviewRequested flags
                const rawPatches = pJson.data || pJson;
                if (Array.isArray(rawPatches)) {
                    const initRequests: Record<string, boolean> = {};
                    rawPatches.forEach((p: any) => {
                        const id = p.issueId || p.id || p.original_id || p.Name;
                        if (id && p.isAiReviewRequested) initRequests[id] = true;
                    });
                    setManualReviewRequests(initRequests);
                }

                const rJson = await rRes.json();
                setReviewedData(rJson);

                if (fRes.ok) {
                    const fJson = await fRes.json();
                    setFeedbacks(fJson.data || []);

                    // Initialize local state with existing feedback
                    const initialLocal: Record<string, { excluded: boolean, reason: string, category?: string, detail?: string }> = {};
                    (fJson.data || []).forEach((f: any) => {
                        let category = '';
                        let detail = f.reason;
                        const match = f.reason.match(/^\[(.*?)\]\s*(.*)$/);
                        if (match) {
                            category = match[1];
                            detail = match[2];
                        }
                        initialLocal[f.issueId] = { excluded: true, reason: f.reason, category, detail };
                    });
                    setLocalExclusions(initialLocal);
                }

            } catch (e) {
                console.error(e);
            } finally {
                setLoading(false);
            }
        };
        fetchData();
    }, [productId]);

    // Poll until the manual-review job completes, then refresh reviewed data
    useEffect(() => {
        if (!isManualReviewing) return;
        const interval = setInterval(async () => {
            try {
                const res = await fetch('/api/pipeline');
                const data = await res.json();
                if (!data.hasActiveJob) {
                    clearInterval(interval);
                    setIsManualReviewing(false);
                    setManualReviewStatus('done');
                    // Refresh reviewed data
                    const rRes = await fetch(`/api/pipeline/stage/reviewed?product=${productId}`);
                    if (rRes.ok) {
                        const rJson = await rRes.json();
                        setReviewedData(rJson);
                    }
                    // Clear selections (flags were cleared in DB by worker)
                    setManualReviewRequests({});
                }
            } catch {
                // ignore transient errors
            }
        }, 3000);
        return () => clearInterval(interval);
    }, [isManualReviewing, productId]);

    const handleSaveFeedback = async (issueId: string, description: string) => {
        const state = localExclusions[issueId];
        if (!state?.excluded || !state?.reason) return;

        setSavingId(issueId);
        try {
            const res = await fetch('/api/pipeline/feedback', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    issueId,
                    description,
                    reason: state.reason
                })
            });
            if (res.ok) {
                // Refresh local feedbacks state
                const fRes = await fetch(`/api/pipeline/feedback`);
                if (fRes.ok) {
                    const fJson = await fRes.json();
                    setFeedbacks(fJson.data || []);
                }
            }
        } catch (e) {
            console.error("Failed to save feedback", e);
        } finally {
            setSavingId(null);
        }
    };

    const toggleExclusion = async (issueId: string, checked: boolean) => {
        setLocalExclusions(prev => ({
            ...prev,
            [issueId]: {
                excluded: checked,
                category: prev[issueId]?.category || '',
                detail: prev[issueId]?.detail || '',
                reason: prev[issueId]?.reason || ''
            }
        }));

        if (!checked) {
            try {
                const res = await fetch(`/api/pipeline/feedback?issueId=${encodeURIComponent(issueId)}`, {
                    method: 'DELETE'
                });
                if (res.ok) {
                    setFeedbacks(prev => prev.filter(f => f.issueId !== issueId));
                }
            } catch (e) {
                console.error("Failed to remove feedback", e);
            }
        }
    };

    const updateExclusionData = (issueId: string, data: { category?: string, detail?: string }) => {
        setLocalExclusions(prev => {
            const current = prev[issueId] || { excluded: true, category: '', detail: '', reason: '' };
            const category = data.category !== undefined ? data.category : (current.category || '');
            const detail = data.detail !== undefined ? data.detail : (current.detail || '');
            const reason = `[${category || 'Uncategorized'}] ${detail}`;

            return {
                ...prev,
                [issueId]: {
                    ...current,
                    category,
                    detail,
                    reason
                }
            };
        });
    };

    const getSeverityInfo = (patch: any): { label: string; isHeuristic: boolean } => {
        const raw = patch.severity || patch.Severity || '';
        const EMPTY_VALS = ['none', 'n/a', '', 'unknown'];
        if (raw && !EMPTY_VALS.includes(raw.toLowerCase())) return { label: raw, isHeuristic: false };

        // Heuristic: derive from description/id keywords
        const text = ((patch.description || patch.Description || patch.summary || '') + ' ' + (patch.issueId || patch.id || '')).toLowerCase();
        if (/critical|remote code execution|\brce\b|unauthenticated|zero.day|zero day/.test(text)) return { label: 'Critical', isHeuristic: true };
        if (/important|high|privilege escalation|elevation of privilege|authentication bypass/.test(text)) return { label: 'Important', isHeuristic: true };
        if (/moderate|medium/.test(text)) return { label: 'Moderate', isHeuristic: true };
        if (/low|informational/.test(text)) return { label: 'Low', isHeuristic: true };
        return { label: 'Unknown', isHeuristic: true };
    };

    const severityBadgeClass = (label: string) => {
        const l = label.toLowerCase();
        if (l === 'critical') return 'bg-red-500/20 border-red-500/40 text-red-700 dark:text-red-400';
        if (l === 'important' || l === 'high') return 'bg-orange-500/20 border-orange-500/40 text-orange-700 dark:text-orange-400';
        if (l === 'moderate' || l === 'medium') return 'bg-yellow-500/20 border-yellow-500/40 text-yellow-800 dark:text-yellow-400';
        if (l === 'low') return 'bg-blue-500/20 border-blue-500/40 text-blue-700 dark:text-blue-400';
        return 'bg-foreground/10 border-foreground/20 text-foreground/50';
    };

    const title = productId === 'redhat' ? "Red Hat Enterprise Linux"
        : productId === 'oracle' ? "Oracle Linux"
            : productId === 'ubuntu' ? "Ubuntu Linux"
                : productId === 'windows' ? "Windows Server"
                    : productId === 'vsphere' ? "VMware vSphere"
                        : productId === 'pgsql' ? "PostgreSQL"
                            : productId === 'ceph' ? "Ceph"
                                : productId === 'mariadb' ? "MariaDB"
                                    : productId === 'sqlserver' ? "SQL Server"
                                        : productId;

    const manualReviewCount = Object.values(manualReviewRequests).filter(Boolean).length;

    const toggleManualReview = async (patchId: string, checked: boolean) => {
        setManualReviewRequests(prev => ({ ...prev, [patchId]: checked }));
        try {
            await fetch('/api/pipeline/review-request', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ issueId: patchId, requested: checked })
            });
        } catch (e) {
            console.error('Failed to update review request flag', e);
        }
    };

    const handleRunManualReview = async () => {
        const issueIds = Object.entries(manualReviewRequests)
            .filter(([, v]) => v)
            .map(([k]) => k);
        if (issueIds.length === 0) return;

        setIsManualReviewing(true);
        setManualReviewStatus('idle');
        try {
            const res = await fetch('/api/pipeline/review-manual', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ issueIds, productId })
            });
            if (!res.ok) {
                const err = await res.json();
                console.error('Manual review failed to queue:', err);
                setIsManualReviewing(false);
                setManualReviewStatus('error');
            }
        } catch (e) {
            console.error('Manual review request error:', e);
            setIsManualReviewing(false);
            setManualReviewStatus('error');
        }
    };

    const filteredPreprocessedData = useMemo(() => {
        if (!preprocessedData) return [];
        const rawData = preprocessedData.data || preprocessedData;
        if (!Array.isArray(rawData)) return [];

        if (!preprocessedSearchQuery.trim()) return rawData;

        const query = preprocessedSearchQuery.toLowerCase();
        return rawData.filter((patch: any) => {
            const patchId = (patch.issueId || patch.id || patch.original_id || patch.Name || "").toLowerCase();
            const component = (patch.component || patch.Component || "").toLowerCase();
            const osVersion = (patch.osVersion || patch.os_version || "").toLowerCase();
            const version = (patch.version || patch.specific_version || "").toLowerCase();

            return patchId.includes(query) || component.includes(query) || osVersion.includes(query) || version.includes(query);
        });
    }, [preprocessedData, preprocessedSearchQuery]);

    return (
        <div className="space-y-6 animate-in fade-in duration-500">
            <div className="flex items-center gap-4">
                <Link href={`/category/${categoryId}`} className="p-2 rounded-full border border-foreground/5 bg-foreground/[0.02] hover:bg-foreground/10 hover:border-foreground/20 transition-all">
                    <ArrowLeft className="w-5 h-5 text-foreground/70" />
                </Link>
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-foreground/90">{title}</h1>
                    <p className="text-foreground/50 text-sm mt-1 mb-2">{dict.dashboard.productDetail.subtitle}</p>
                </div>
            </div>

            {finalizeSuccess && (
                <div className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-700 dark:text-emerald-300 px-6 py-4 rounded-xl flex items-center gap-3 animate-in slide-in-from-top-4 shadow-[0_0_20px_rgba(16,185,129,0.1)]">
                    <CheckCircle2 className="w-6 h-6" />
                    <div>
                        <p className="font-semibold text-emerald-800 dark:text-emerald-200">{dict.dashboard.feedback.reviewFinalized}</p>
                        <p className="text-sm opacity-80 mt-0.5">{dict.dashboard.feedback.reviewFinalizedDesc}</p>
                    </div>
                </div>
            )}

            {loading ? (
                <div className="flex items-center gap-3 text-emerald-700 dark:text-emerald-400 p-8 border border-foreground/5 rounded-xl bg-card">
                    <Loader2 className="w-5 h-5 animate-spin" /> {dict.dashboard.productDetail.fetching}
                </div>
            ) : (
                <Tabs defaultValue="preprocessed" className="w-full">
                    <TabsList className="bg-card border border-foreground/10 mb-6 p-1 h-auto">
                        <TabsTrigger value="preprocessed" className="data-[state=active]:bg-emerald-500/20 data-[state=active]:text-emerald-700 dark:data-[state=active]:text-emerald-400 px-6 py-2">
                            {dict.dashboard.productDetail.tabPreprocessed}
                        </TabsTrigger>
                        <TabsTrigger value="reviewed" className="data-[state=active]:bg-blue-500/20 data-[state=active]:text-blue-700 dark:data-[state=active]:text-blue-400 px-6 py-2">
                            {dict.dashboard.productDetail.tabReviewed}
                        </TabsTrigger>
                    </TabsList>

                    <TabsContent value="preprocessed" className="mt-0">
                        <div className="bg-card border border-foreground/10 rounded-xl p-6 shadow-xl">
                            {manualReviewStatus === 'done' && (
                                <div className="mb-4 bg-emerald-500/10 border border-emerald-500/20 text-emerald-700 dark:text-emerald-300 px-5 py-3 rounded-xl flex items-center gap-3 animate-in slide-in-from-top-4">
                                    <CheckCircle2 className="w-5 h-5" />
                                    <p className="text-sm font-medium">{dict.dashboard.productDetail.manualReviewDone}</p>
                                </div>
                            )}

                            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
                                <div>
                                    <h3 className="text-xl font-light text-foreground mb-2">{dict.dashboard.productDetail.preprocessedTitle}</h3>
                                    <p className="text-foreground/40 text-sm mb-0">{dict.dashboard.productDetail.preprocessedDesc}</p>
                                </div>
                                <div className="flex items-center gap-3 flex-wrap justify-end">
                                    {manualReviewCount > 0 && (
                                        <button
                                            onClick={handleRunManualReview}
                                            disabled={isManualReviewing}
                                            className="flex items-center gap-2 px-4 py-2 bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-700 disabled:text-zinc-400 text-white font-medium rounded-lg text-sm transition-colors shadow-[0_0_15px_rgba(139,92,246,0.4)] disabled:shadow-none whitespace-nowrap"
                                        >
                                            {isManualReviewing ? (
                                                <><Loader2 className="w-4 h-4 animate-spin" />{dict.dashboard.productDetail.manualReviewRunning}</>
                                            ) : (
                                                <><BrainCircuit className="w-4 h-4" />{dict.dashboard.productDetail.runManualReview} ({manualReviewCount}{dict.dashboard.productDetail.selectedForReview})</>
                                            )}
                                        </button>
                                    )}
                                <div className="relative w-full md:w-72">
                                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                        <Search className="h-4 w-4 text-emerald-500/70" />
                                    </div>
                                    <input
                                        type="text"
                                        className="block w-full pl-10 pr-3 py-2 border border-foreground/10 rounded-lg bg-card/80 text-foreground placeholder:text-foreground/30 focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 sm:text-sm transition-colors"
                                        placeholder={dict.dashboard.productDetail.searchPlaceholder}
                                        value={preprocessedSearchQuery}
                                        onChange={(e) => setPreprocessedSearchQuery(e.target.value)}
                                    />
                                </div>
                                </div>
                            </div>

                            {filteredPreprocessedData.length > 0 ? (
                                <div className="space-y-4">
                                    {filteredPreprocessedData.map((patch: any, idx: number) => {
                                        const patchId = patch.issueId || patch.id || patch.original_id || patch.Name || `${dict.dashboard.productDetail.patchElement}${idx + 1}`;

                                        // Check if this patch made it into the final recommended list (reviewedData)
                                        let isApproved = false;
                                        if (reviewedData?.data && Array.isArray(reviewedData.data)) {
                                            isApproved = reviewedData.data.some((rPatch: any) => {
                                                const rId = rPatch.IssueID || rPatch['Issue ID'] || rPatch.Issue_ID;
                                                const isCrit = rPatch.Criticality?.toLowerCase() === 'critical';
                                                return (rId === patch.issueId || rId === patch.id || rId === patch.original_id || rId === patch.Name);
                                            });
                                        }

                                        const { label: sevLabel, isHeuristic: sevHeuristic } = getSeverityInfo(patch);

                                        return (
                                            <div key={idx} className={`p-5 rounded-xl border transition-colors flex flex-col gap-3 ${isApproved ? 'bg-blue-500/10 border-blue-500/30' : 'bg-foreground/[0.02] border-foreground/5 hover:bg-foreground/[0.04]'}`}>
                                                <div className="flex items-start justify-between">
                                                    <div className="flex items-center gap-3">
                                                        <h4 className={`text-base font-medium ${isApproved ? 'text-blue-700 dark:text-blue-300' : 'text-emerald-700 dark:text-emerald-300'}`}>
                                                            {patchId}
                                                        </h4>
                                                        <span className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold uppercase tracking-wider ${severityBadgeClass(sevLabel)}`} title={sevHeuristic ? 'Heuristic estimate' : 'From vendor data'}>
                                                            {sevLabel}{sevHeuristic ? ` ${dict?.dashboard?.productDetail?.severityHeuristic || '(est.)'}` : ''}
                                                        </span>
                                                        {isApproved && (
                                                            <div className="flex items-center gap-1.5 px-2 py-0.5 bg-blue-500/20 text-blue-700 dark:text-blue-300 border border-blue-500/40 rounded-full shadow-[0_0_10px_rgba(59,130,246,0.2)]">
                                                                <BrainCircuit className="w-3 h-3" />
                                                                <span className="text-[10px] uppercase font-bold tracking-wider">{dict.dashboard.feedback.aiRecommended}</span>
                                                            </div>
                                                        )}
                                                    </div>
                                                    <div className="flex items-center gap-3">
                                                        <span className={`text-xs px-2.5 py-1 border rounded-full font-mono ${isApproved ? 'bg-blue-500/10 border-blue-500/30 text-blue-600 dark:text-blue-400' : 'bg-muted border-border text-muted-foreground'}`}>
                                                            {patch.vendor || patch.Type || dict.dashboard.productDetail.update}
                                                        </span>
                                                        {!isApproved && (
                                                            <div className="flex items-center space-x-2">
                                                                <input
                                                                    type="checkbox"
                                                                    checked={manualReviewRequests[patchId] === true}
                                                                    onChange={(e) => toggleManualReview(patchId, e.target.checked)}
                                                                    id={`request-review-${patchId}`}
                                                                    disabled={isManualReviewing}
                                                                    className="w-4 h-4 rounded border-foreground/20 bg-card/80 text-violet-500 focus:ring-violet-500/50 focus:ring-offset-0 disabled:opacity-50 accent-violet-500"
                                                                />
                                                                <label htmlFor={`request-review-${patchId}`} className="text-sm font-medium text-foreground/80 cursor-pointer">
                                                                    {dict.dashboard.productDetail.requestReview}
                                                                </label>
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>

                                                <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 py-3 border-t border-foreground/5 mt-1">
                                                    {(patch.osVersion || patch.os_version) && (
                                                        <div>
                                                            <p className="text-xs text-foreground/40 uppercase tracking-wider mb-1">{dict.dashboard.productDetail.osVersionLabel}</p>
                                                            <p className="text-sm font-light text-emerald-700 dark:text-emerald-100 font-medium">{patch.osVersion || patch.os_version}</p>
                                                        </div>
                                                    )}
                                                    {patch.component && (
                                                        <div>
                                                            <p className="text-xs text-foreground/40 uppercase tracking-wider mb-1">{dict.dashboard.productDetail.component}</p>
                                                            <p className="text-sm font-light text-foreground/80">{patch.component}</p>
                                                        </div>
                                                    )}
                                                    {(patch.version || patch.specific_version) && (
                                                        <div>
                                                            <p className="text-xs text-foreground/40 uppercase tracking-wider mb-1">{dict.dashboard.productDetail.version}</p>
                                                            <p className="text-sm font-light text-foreground/80">{patch.version || patch.specific_version}</p>
                                                        </div>
                                                    )}
                                                    {(patch.date || patch.releaseDate) && (
                                                        <div>
                                                            <p className="text-xs text-foreground/40 uppercase tracking-wider mb-1">{dict.dashboard.productDetail.releaseDate}</p>
                                                            <p className="text-sm font-light text-foreground/80">{patch.date || patch.releaseDate}</p>
                                                        </div>
                                                    )}
                                                    {patch.summary && (
                                                        <div className="col-span-2 lg:col-span-5 border-t border-foreground/5 pt-2 mt-1">
                                                            <p className="text-xs text-foreground/40 uppercase tracking-wider mb-1">{dict.dashboard.productDetail.description}</p>
                                                            <p className="text-xs font-mono text-emerald-700 dark:text-emerald-300/80 max-w-full truncate" title={patch.summary}>{patch.summary}</p>
                                                        </div>
                                                    )}
                                                </div>

                                                {(patch.description || patch.Description || patch.diff_content) && (
                                                    <div className="mt-1 space-y-2">
                                                        <p className="text-xs text-foreground/40 uppercase tracking-wider mb-0">{dict.dashboard.productDetail.description}</p>
                                                        <p className="text-sm text-foreground/70 font-light leading-relaxed whitespace-pre-line line-clamp-3 hover:line-clamp-none transition-all cursor-pointer">
                                                            {patch.description || patch.Description || patch.diff_content}
                                                        </p>
                                                    </div>
                                                )}

                                                {(patch.url || patch.ref_url) && (
                                                    <div className="mt-2 pt-2 border-t border-foreground/5">
                                                        <p className="text-xs text-foreground/40 uppercase tracking-wider mb-1">{dict?.dashboard?.productDetail?.urlLabel || "URL"}</p>
                                                        <a href={patch.url || patch.ref_url} target="_blank" rel="noreferrer" className="text-sm text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 transition-colors break-all">
                                                            {patch.url || patch.ref_url}
                                                        </a>
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            ) : (
                                <div className="p-12 text-center text-foreground/30 border border-dashed border-foreground/10 rounded-lg bg-background/50">
                                    {dict.dashboard.productDetail.noData}
                                </div>
                            )}
                        </div>
                    </TabsContent>

                    <TabsContent value="reviewed" className="mt-0 space-y-4">
                        <div className="bg-card border border-foreground/10 rounded-xl p-6 shadow-xl">
                            <h3 className="text-xl font-light text-foreground mb-2">{dict.dashboard.productDetail.reviewTitle}</h3>
                            <p className="text-foreground/40 text-sm mb-8">{dict.dashboard.productDetail.reviewDesc}</p>

                            {reviewedData?.data && Array.isArray(reviewedData.data) ? (
                                <div className="space-y-6">
                                    {reviewedData.data.map((patch: any, idx: number) => {
                                        const issueId = patch.IssueID || patch['Issue ID'] || patch.Issue_ID || `${dict.dashboard.productDetail.unknownIssuePrefix}${idx}`;
                                        const isCritical = patch.Criticality?.toLowerCase() === 'critical';
                                        const isExcludedLocally = localExclusions[issueId]?.excluded;
                                        const isSavedLocally = feedbacks.some(f => f.issueId === issueId && f.reason === localExclusions[issueId]?.reason);

                                        return (
                                            <div key={idx} className={`p-6 rounded-xl border flex flex-col gap-3 transition-colors ${isExcludedLocally ? 'bg-background border-dashed border-red-500/30' : isCritical ? 'bg-red-500/5 border-red-500/20 shadow-[0_0_15px_-3px_rgba(239,68,68,0.1)]' : 'bg-foreground/[0.02] border-foreground/5'}`}>
                                                <div className="flex items-start justify-between">
                                                    <div className="flex items-center gap-3 flex-wrap">
                                                        {isCritical ? <AlertTriangle className="w-5 h-5 text-red-600 dark:text-red-400 flex-shrink-0" /> : <CheckCircle2 className="w-5 h-5 text-emerald-700 dark:text-emerald-400 flex-shrink-0" />}
                                                        <h4 className={`text-lg font-medium ${isExcludedLocally ? 'text-zinc-500 line-through' : isCritical ? 'text-red-700 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-400'}`}>
                                                            {issueId}
                                                        </h4>
                                                        <label className="flex items-center gap-2 ml-4 px-3 py-1 bg-foreground/[0.04] border border-foreground/10 rounded-full cursor-pointer hover:bg-foreground/5 transition-colors">
                                                            <input
                                                                type="checkbox"
                                                                className="accent-red-500 cursor-pointer w-4 h-4"
                                                                checked={isExcludedLocally || false}
                                                                onChange={(e) => toggleExclusion(issueId, e.target.checked)}
                                                            />
                                                            <span className="text-xs text-foreground/60">{dict.dashboard.feedback.exclude}</span>
                                                        </label>
                                                    </div>
                                                    <span className={`text-xs px-3 py-1 font-medium rounded-full ${isExcludedLocally ? 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-400' : isCritical ? 'bg-red-500/20 text-red-700 dark:text-red-300 border border-red-500/30' : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20'}`}>
                                                        {patch.Criticality ? (dict.dashboard.productDetail.criticalityMap[patch.Criticality.toLowerCase()] || patch.Criticality) : dict.dashboard.productDetail.normal}
                                                    </span>
                                                </div>

                                                {isExcludedLocally && (
                                                    <div className="my-3 p-5 bg-gradient-to-r from-red-950/60 to-black border border-red-500/60 rounded-xl flex flex-col gap-4 shadow-[0_0_30px_rgba(239,68,68,0.25)] relative overflow-hidden z-10 transition-all">
                                                        <div className="absolute top-0 left-0 w-1 h-full bg-red-500 shadow-[0_0_10px_rgba(239,68,68,1)]"></div>
                                                        <div className="flex items-center gap-2 mb-1">
                                                            <BrainCircuit className="w-6 h-6 text-red-400 animate-pulse" />
                                                            <p className="text-base text-red-300 font-bold tracking-wide">{dict.dashboard.feedback.aiContextTitle}</p>
                                                        </div>

                                                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                                            <div className="md:col-span-1">
                                                                <label className="text-xs text-red-300/80 mb-1.5 block font-medium">{dict.dashboard.feedback.categoryLabel}</label>
                                                                <select
                                                                    className="w-full bg-card/80 border border-red-500/30 rounded-lg px-4 py-2.5 text-sm text-foreground focus:outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500/50 transition-all cursor-pointer"
                                                                    value={localExclusions[issueId]?.category || ''}
                                                                    onChange={(e) => updateExclusionData(issueId, { category: e.target.value })}
                                                                >
                                                                    <option value="" disabled>{dict.dashboard.feedback.categoryPlaceholder}</option>
                                                                    <option value="Environment Mismatch (e.g., Module not used)">{dict.dashboard.feedback.options.envMismatch}</option>
                                                                    <option value="Compensating Control Exists">{dict.dashboard.feedback.options.compensatingControl}</option>
                                                                    <option value="Risk Assessed & Accepted">{dict.dashboard.feedback.options.riskAccepted}</option>
                                                                    <option value="Dependency Conflict (Breaks App)">{dict.dashboard.feedback.options.dependencyConflict}</option>
                                                                    <option value="Other">{dict.dashboard.feedback.options.other}</option>
                                                                </select>
                                                            </div>
                                                            <div className="md:col-span-2 flex flex-col">
                                                                <label className="text-xs text-red-300/80 mb-1.5 block font-medium">{dict.dashboard.feedback.detailLabel}</label>
                                                                <div className="flex gap-3 flex-1">
                                                                    <input
                                                                        type="text"
                                                                        className="flex-1 bg-card/80 border border-red-500/30 rounded-lg px-4 py-2.5 text-sm text-foreground focus:outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500/50 transition-all"
                                                                        placeholder={dict.dashboard.feedback.detailPlaceholder}
                                                                        value={localExclusions[issueId]?.detail || ''}
                                                                        onChange={(e) => updateExclusionData(issueId, { detail: e.target.value })}
                                                                    />
                                                                    <button
                                                                        className="px-6 py-2.5 bg-red-600 hover:bg-red-500 text-foreground font-medium rounded-lg text-sm transition-colors flex items-center gap-2 disabled:opacity-50 disabled:bg-zinc-800 disabled:text-zinc-500 border border-red-500 disabled:border-zinc-700 shadow-[0_0_15px_rgba(239,68,68,0.4)] disabled:shadow-none whitespace-nowrap"
                                                                        onClick={() => handleSaveFeedback(issueId, patch.Description || patch['Patch Description'] || patch.PatchDescription || "Unknown")}
                                                                        disabled={!localExclusions[issueId]?.category || !localExclusions[issueId]?.detail || isSavedLocally || savingId === issueId}
                                                                    >
                                                                        {savingId === issueId ? <Loader2 className="w-4 h-4 animate-spin" /> : (isSavedLocally ? dict.dashboard.feedback.feedbackSaved : dict.dashboard.feedback.submitFeedback)}
                                                                    </button>
                                                                </div>
                                                            </div>
                                                        </div>

                                                        <div className="flex items-start gap-2 mt-2 bg-background/60 p-3 rounded-lg border border-red-500/20 text-xs text-foreground/70 leading-relaxed">
                                                            <Info className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                                                            <p>
                                                                <strong className="text-red-300 font-semibold">{dict.dashboard.feedback.contextMatters}</strong> {dict.dashboard.feedback.contextDesc}
                                                            </p>
                                                        </div>
                                                    </div>
                                                )}

                                                <div className={`transition-opacity duration-300 ${isExcludedLocally ? 'opacity-40 grayscale pointer-events-none' : 'opacity-100'}`}>
                                                    <div className="grid grid-cols-2 lg:grid-cols-6 gap-4 mt-2 py-3 border-y border-foreground/5">
                                                        {(patch.osVersion || patch.OsVersion) && (
                                                            <div>
                                                                <p className="text-xs text-foreground/40 uppercase tracking-wider mb-1">{dict.dashboard.productDetail.osVersionLabel}</p>
                                                                <p className="text-sm font-light text-blue-700 dark:text-blue-100 font-medium">{patch.osVersion || patch.OsVersion || dict?.dashboard?.productDetail?.unknown || 'Unknown'}</p>
                                                            </div>
                                                        )}
                                                        <div>
                                                            <p className="text-xs text-foreground/40 uppercase tracking-wider mb-1">{dict.dashboard.productDetail.component}</p>
                                                            <p className="text-sm font-light text-foreground/80">{patch.Component}</p>
                                                        </div>
                                                        <div>
                                                            <p className="text-xs text-foreground/40 uppercase tracking-wider mb-1">{dict.dashboard.productDetail.version}</p>
                                                            <p className="text-sm font-light text-foreground/80 max-w-[150px] truncate" title={patch.Version || patch.version}>{patch.Version || patch.version}</p>
                                                        </div>
                                                        <div>
                                                            <p className="text-xs text-foreground/40 uppercase tracking-wider mb-1">{dict.dashboard.productDetail.vendorId}</p>
                                                            <p className="text-sm font-light text-foreground/80">{patch.Vendor}</p>
                                                        </div>
                                                        {(patch.Date || patch.date || patch.releaseDate) && (
                                                            <div>
                                                                <p className="text-xs text-foreground/40 uppercase tracking-wider mb-1">{dict.dashboard.productDetail.releaseDate}</p>
                                                                <p className="text-sm font-light text-foreground/80">{patch.Date || patch.date || patch.releaseDate}</p>
                                                            </div>
                                                        )}
                                                        <div>
                                                            <p className="text-xs text-foreground/40 uppercase tracking-wider mb-1">{dict?.dashboard?.productDetail?.urlLabel || "URL"}</p>
                                                            {patch.Url || patch.url || patch.ref_url ? (
                                                                <a href={patch.Url || patch.url || patch.ref_url} target="_blank" rel="noopener noreferrer" className="text-sm font-light text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 hover:underline flex items-center gap-1 group">
                                                                    {dict?.dashboard?.productDetail?.viewAdvisory || "View Advisory"}
                                                                    <svg className="w-3 h-3 group-hover:translate-x-0.5 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                                                                </a>
                                                            ) : (
                                                                <p className="text-sm font-light text-foreground/50">{dict?.dashboard?.productDetail?.notAvailable || "N/A"}</p>
                                                            )}
                                                        </div>
                                                    </div>
                                                    <div className="mt-2 space-y-4">
                                                        <div>
                                                            <p className="text-xs text-foreground/40 uppercase tracking-wider mb-1">{dict.dashboard.productDetail.description}</p>
                                                            <p className="text-sm text-foreground/70 font-light leading-relaxed">{patch.Description || patch['Patch Description'] || patch.PatchDescription}</p>
                                                        </div>
                                                        {(patch.KoreanDescription || patch['한글 설명']) && (
                                                            <div className="p-4 bg-blue-500/10 rounded-lg border border-blue-500/20">
                                                                <p className="text-[10px] text-blue-700 dark:text-blue-400/80 font-semibold uppercase tracking-widest mb-2 flex items-center gap-2">
                                                                    <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span>
                                                                    {dict.dashboard.productDetail.aiTranslation}
                                                                </p>
                                                                <p className="text-sm text-blue-800 dark:text-blue-100 font-medium leading-relaxed">{patch.KoreanDescription || patch['한글 설명']}</p>
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        )
                                    })}
                                </div>
                            ) : (
                                <div className="p-12 text-center text-foreground/30 border border-dashed border-foreground/10 rounded-lg bg-background/50">
                                    {dict.dashboard.productDetail.noData}
                                    <br /><span className="text-xs mt-2 block">{dict.dashboard.productDetail.noDataSub}</span>
                                </div>
                            )}

                            {reviewedData?.data && Array.isArray(reviewedData.data) && reviewedData.data.length > 0 && (
                                <div className="mt-8 pt-6 border-t border-foreground/10 flex justify-end">
                                    <button
                                        onClick={async () => {
                                            setIsFinalizing(true);
                                            try {
                                                const approvedIssueIds = reviewedData.data
                                                    .filter((patch: any) => {
                                                        const issueId = patch.IssueID || patch['Issue ID'] || patch.Issue_ID;
                                                        return !localExclusions[issueId]?.excluded;
                                                    })
                                                    .map((patch: any) => patch.IssueID || patch['Issue ID'] || patch.Issue_ID);

                                                let finalizeEndpoint = '/api/pipeline/finalize';
                                                if (categoryId === 'storage') finalizeEndpoint = '/api/pipeline/ceph/finalize';
                                                else if (categoryId === 'database' && productId === 'pgsql') finalizeEndpoint = '/api/pipeline/pgsql/finalize';
                                                else if (categoryId === 'database' && productId === 'sqlserver') finalizeEndpoint = '/api/pipeline/sqlserver/finalize';
                                                else if (categoryId === 'database') finalizeEndpoint = '/api/pipeline/mariadb/finalize';
                                                else if (productId === 'windows') finalizeEndpoint = '/api/pipeline/windows/finalize';
                                                else if (categoryId === 'virtualization') finalizeEndpoint = '/api/pipeline/vsphere/finalize';
                                                const res = await fetch(finalizeEndpoint, {
                                                    method: 'POST',
                                                    headers: { 'Content-Type': 'application/json' },
                                                    body: JSON.stringify({
                                                        productId,
                                                        categoryId,
                                                        approvedIssueIds
                                                    })
                                                });
                                                if (res.ok) {
                                                    setFinalizeSuccess(true);
                                                    setIsDone(true);
                                                    setTimeout(() => setFinalizeSuccess(false), 8000);
                                                    // Auto-archive: if all products are done, create quarterly archive
                                                    fetch('/api/archive/quarterly/auto-check', { method: 'POST' })
                                                        .then(r => r.json())
                                                        .then(d => { if (d.triggered) console.log(`[Auto-Archive] Created: ${d.quarter} (${d.totalPatches} patches)`); })
                                                        .catch(e => console.warn('[Auto-Archive] check failed:', e));
                                                } else {
                                                    alert(dict?.dashboard?.productDetail?.finalizeFailed || "Failed to finalize. See console.");
                                                    console.error(await res.text());
                                                }
                                            } catch (e) {
                                                console.error(e);
                                            } finally {
                                                setIsFinalizing(false);
                                            }
                                        }}
                                        disabled={isFinalizing || isDone}
                                        className={`font-semibold py-3 px-8 rounded-xl transition-all flex items-center gap-3 ${isDone
                                            ? "bg-emerald-600/30 text-emerald-800 dark:text-emerald-300 border border-emerald-500/50 cursor-not-allowed shadow-[0_0_15px_rgba(16,185,129,0.2)]"
                                            : "bg-blue-600 hover:bg-blue-500 text-white shadow-[0_0_20px_rgba(59,130,246,0.5)] disabled:opacity-50 disabled:shadow-none"
                                            }`}
                                    >
                                        {isFinalizing ? <Loader2 className="w-5 h-5 animate-spin" /> : <CheckCircle2 className="w-5 h-5" />}
                                        {isFinalizing ? dict.dashboard.feedback.finalizing : isDone ? dict.dashboard.feedback.reviewCompleted : dict.dashboard.feedback.markAsDone}
                                    </button>
                                </div>
                            )}
                        </div>
                    </TabsContent>
                </Tabs>
            )
            }
        </div >
    );
}

