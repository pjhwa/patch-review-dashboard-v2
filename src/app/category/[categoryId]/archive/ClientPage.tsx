"use client"
import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, ArrowLeft, Download, Plus, Archive, ChevronDown, ChevronUp } from "lucide-react";
import Link from 'next/link';

export function CategoryArchiveClient({ categoryId, dict }: { categoryId: string, dict: any }) {
    const [quarters, setQuarters] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [showCreate, setShowCreate] = useState(false);
    const [newQuarter, setNewQuarter] = useState('');
    const [creating, setCreating] = useState(false);
    const [createError, setCreateError] = useState('');
    const [createSuccess, setCreateSuccess] = useState('');

    const d = dict.dashboard.archivePage;

    const fetchData = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch('/api/archive/quarterly');
            if (res.ok) {
                const data = await res.json();
                setQuarters(data.quarters || []);
            }
        } catch (e) {
            console.error("Failed to fetch archive data:", e);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchData(); }, [fetchData]);

    const handleCreate = async () => {
        if (!newQuarter.match(/^Q[1-4] \d{4}$/)) {
            setCreateError(d.invalidQuarterFormat || 'Format must be Q1 2025 ~ Q4 2099');
            return;
        }
        setCreating(true);
        setCreateError('');
        setCreateSuccess('');
        try {
            const res = await fetch('/api/archive/quarterly', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ quarter: newQuarter })
            });
            const data = await res.json();
            if (res.ok) {
                setCreateSuccess(d.createSuccess?.replace('{quarter}', newQuarter) || `Archive for ${newQuarter} created (${data.totalPatches} patches)`);
                setNewQuarter('');
                setShowCreate(false);
                await fetchData();
            } else {
                setCreateError(data.error || 'Failed to create archive');
            }
        } catch {
            setCreateError('Network error');
        } finally {
            setCreating(false);
        }
    };

    const categoryLabel = categoryId === 'os' ? 'OS' : categoryId.charAt(0).toUpperCase() + categoryId.slice(1);

    return (
        <div className="space-y-6 animate-in fade-in duration-500 min-h-screen">

            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
                <div className="flex items-center gap-4">
                    <Link
                        href={`/category/${categoryId}`}
                        className="p-2 rounded-full border border-foreground/5 bg-foreground/[0.02] hover:bg-foreground/10 hover:border-foreground/20 transition-all flex-shrink-0"
                    >
                        <ArrowLeft className="w-5 h-5 text-foreground/70" />
                    </Link>
                    <div>
                        <h1 className="text-3xl font-bold tracking-tight text-foreground/90">
                            {categoryLabel} {d.title}
                        </h1>
                        <p className="text-foreground/50 text-sm mt-1">{d.quarterlySubtitle}</p>
                    </div>
                </div>
                <button
                    onClick={() => { setShowCreate(!showCreate); setCreateError(''); setCreateSuccess(''); }}
                    className="flex items-center gap-2 px-4 py-2 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 text-sm font-semibold rounded-lg border border-emerald-500/20 transition-colors self-start sm:self-auto flex-shrink-0"
                >
                    {showCreate ? <ChevronUp className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                    {d.createArchive}
                </button>
            </div>

            {/* Create Archive Panel */}
            {showCreate && (
                <div className="p-6 border border-emerald-500/20 rounded-xl bg-emerald-500/[0.04] space-y-4">
                    <div>
                        <h3 className="text-sm font-semibold text-emerald-400">{d.createArchiveTitle}</h3>
                        <p className="text-foreground/40 text-xs mt-1">{d.createArchiveDesc}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                        <div className="flex flex-col gap-1">
                            <label className="text-foreground/50 text-xs">{d.quarterLabel}</label>
                            <input
                                type="text"
                                value={newQuarter}
                                onChange={e => { setNewQuarter(e.target.value); setCreateError(''); }}
                                placeholder={d.quarterPlaceholder}
                                className="w-40 px-3 py-2 bg-background border border-foreground/10 rounded-lg text-foreground text-sm focus:border-emerald-500/40 focus:outline-none placeholder:text-foreground/20"
                                onKeyDown={e => e.key === 'Enter' && handleCreate()}
                            />
                        </div>
                        <button
                            onClick={handleCreate}
                            disabled={creating || !newQuarter}
                            className="flex items-center gap-2 px-4 py-2 mt-5 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 text-sm font-semibold rounded-lg border border-emerald-500/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Archive className="w-4 h-4" />}
                            {creating ? d.creating : d.createArchive}
                        </button>
                    </div>
                    {createError && <p className="text-red-400/80 text-xs">{createError}</p>}
                    {createSuccess && <p className="text-emerald-400 text-xs">{createSuccess}</p>}
                </div>
            )}

            {/* Content */}
            {loading ? (
                <div className="flex items-center gap-3 text-emerald-400 p-8 border border-foreground/5 rounded-xl bg-card">
                    <Loader2 className="w-5 h-5 animate-spin" /> {d.loading}
                </div>
            ) : quarters.length === 0 ? (
                <div className="p-16 text-center border-dashed border border-foreground/10 rounded-xl bg-foreground/[0.01]">
                    <Archive className="w-12 h-12 text-foreground/15 mx-auto mb-4" />
                    <p className="text-foreground/40 font-medium mb-2">{d.noQuarters}</p>
                    <p className="text-foreground/25 text-xs">{d.noQuartersSub}</p>
                </div>
            ) : (
                <Tabs defaultValue={quarters[0]?.dirName || quarters[0]?.quarter.replace(' ', '-')} className="w-full">

                    {/* Quarter Tabs */}
                    <TabsList className="bg-card border border-foreground/10 mb-6 p-1 h-auto flex flex-wrap gap-1">
                        {quarters.map(q => {
                            const tabKey = q.dirName || q.quarter.replace(' ', '-');
                            const categoryProducts = (q.products || []).filter((p: any) => p.categoryId === categoryId);
                            const catPatchCount = categoryProducts.reduce((sum: number, p: any) => sum + p.patchCount, 0);
                            return (
                                <TabsTrigger
                                    key={q.quarter}
                                    value={tabKey}
                                    className="data-[state=active]:bg-emerald-500/20 data-[state=active]:text-emerald-400 px-5 py-2 text-sm"
                                >
                                    {q.quarter}
                                    {catPatchCount > 0 && (
                                        <span className="ml-2 px-1.5 py-0.5 text-[10px] rounded bg-foreground/[0.06] text-foreground/40">
                                            {catPatchCount}
                                        </span>
                                    )}
                                </TabsTrigger>
                            );
                        })}
                    </TabsList>

                    {/* Quarter Content */}
                    {quarters.map(q => {
                        const tabKey = q.dirName || q.quarter.replace(' ', '-');
                        const categoryProducts = (q.products || []).filter((p: any) => p.categoryId === categoryId);

                        return (
                            <TabsContent key={q.quarter} value={tabKey} className="mt-0 space-y-4">

                                {/* Archive Meta Bar */}
                                <div className="flex flex-wrap items-center gap-3 px-4 py-3 rounded-lg bg-foreground/[0.02] border border-foreground/5">
                                    <div className="flex items-center gap-2">
                                        <Archive className="w-4 h-4 text-foreground/30" />
                                        <span className="text-foreground/60 text-sm font-medium">{q.quarter}</span>
                                    </div>
                                    <div className="h-3 w-px bg-white/10"></div>
                                    <Badge variant="outline" className="border-foreground/10 text-foreground/40 bg-transparent text-xs">
                                        {d.archived} {new Date(q.createdAt).toLocaleDateString()}
                                    </Badge>
                                    <div className="h-3 w-px bg-white/10"></div>
                                    <span className="text-foreground/30 text-xs">
                                        {q.totalPatches} {d.patches} · {q.products?.length || 0} {d.productsAll}
                                    </span>
                                    {categoryProducts.length > 0 && (
                                        <>
                                            <div className="h-3 w-px bg-white/10"></div>
                                            <a
                                                href={`/api/archive/quarterly/${tabKey}/download?categoryId=${categoryId}`}
                                                className="flex items-center gap-1.5 text-xs text-foreground/40 hover:text-emerald-400 transition-colors"
                                            >
                                                <Download className="w-3 h-3" />
                                                {d.downloadAll}
                                            </a>
                                        </>
                                    )}
                                </div>

                                {/* Product Cards */}
                                {categoryProducts.length === 0 ? (
                                    <div className="p-12 text-center text-foreground/30 border border-dashed border-foreground/10 rounded-lg bg-background/50">
                                        {d.noHistory}
                                        <br /><span className="text-xs mt-2 block text-foreground/20">{d.noHistorySub}</span>
                                    </div>
                                ) : (
                                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 pt-2">
                                        {categoryProducts.map((prod: any) => (
                                            <Card
                                                key={prod.productId}
                                                className="relative overflow-hidden border-white/[0.06] bg-card transition-all duration-300 hover:border-foreground/20 hover:bg-white/[0.04] hover:shadow-[0_0_30px_-5px_rgba(255,255,255,0.05)]"
                                            >
                                                <CardHeader className="pb-2 border-b border-foreground/5 bg-black/40">
                                                    <div className="flex justify-between items-center">
                                                        <CardTitle className="text-xs font-medium text-foreground/50 uppercase tracking-wider">
                                                            {prod.productName}
                                                        </CardTitle>
                                                        <Badge variant="outline" className="border-emerald-500/20 text-emerald-400/70 bg-emerald-500/5 text-xs">
                                                            {prod.patchCount} {d.patches}
                                                        </Badge>
                                                    </div>
                                                </CardHeader>
                                                <CardContent className="pt-4 relative">
                                                    <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-500/5 rounded-full blur-3xl -mr-16 -mt-16 pointer-events-none"></div>
                                                    <div className="text-xs text-foreground/25 mb-3 font-mono truncate">
                                                        {q.quarter} · {prod.categoryId}
                                                    </div>
                                                    <a
                                                        href={`/api/archive/quarterly/${tabKey}/download?categoryId=${categoryId}&productId=${prod.productId}`}
                                                        className="flex items-center justify-center gap-2 w-full px-4 py-2.5 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 text-xs font-semibold rounded-lg transition-colors border border-emerald-500/20 shadow-[0_0_15px_rgba(16,185,129,0.08)]"
                                                    >
                                                        <Download className="w-4 h-4" />
                                                        {d.downloadCsv}
                                                    </a>
                                                </CardContent>
                                            </Card>
                                        ))}
                                    </div>
                                )}
                            </TabsContent>
                        );
                    })}
                </Tabs>
            )}
        </div>
    );
}
