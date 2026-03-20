"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import Link from 'next/link';
import { useState } from 'react';
import { Loader2, CheckCircle2 } from "lucide-react";

export function PremiumCard({
    title, stages, desc, active, href, categoryId, productId, isRunning, onRunPipeline, onRunAiOnly, isReviewCompleted, dict
}: {
    title: string, stages?: { collected: number, preprocessed: number, reviewed: number, approved?: number }, desc: string, active: boolean, href: string, categoryId: string, productId: string, isRunning?: boolean, onRunPipeline?: () => void, onRunAiOnly?: () => void, isReviewCompleted?: boolean, dict?: any
}) {

    return (
        <Card className={`relative overflow-hidden border-border bg-card backdrop-blur-xl transition-all duration-300 ${active ? 'hover:-translate-y-1 hover:border-foreground/20 hover:bg-foreground/[0.04] hover:shadow-[0_0_30px_-5px_rgba(0,0,0,0.08)]' : 'opacity-50 grayscale'}`}>
            <Link href={active ? href : "#"} className={`block group ${active ? 'cursor-pointer' : 'cursor-default'}`}>
                <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-foreground/70 uppercase tracking-wider group-hover:text-foreground transition-colors">{title}</CardTitle>
                </CardHeader>
                <CardContent>
                    {stages ? (
                        <div className="grid grid-cols-3 gap-2 mt-2 mb-4">
                            <div className="flex flex-col">
                                <span className="text-xs text-foreground/40 mb-1">{dict?.dashboard?.premiumCard?.collected || 'Collected'}</span>
                                <span className="text-2xl font-light tracking-tighter text-foreground/80">{stages.collected}</span>
                            </div>
                            <div className="flex flex-col border-l border-foreground/5 pl-2">
                                <span className="text-xs text-foreground/40 mb-1">{dict?.dashboard?.premiumCard?.preprocessed || 'Preprocessed'}</span>
                                <span className="text-2xl font-light tracking-tighter text-emerald-500/80">{stages.preprocessed}</span>
                            </div>
                            <div className="flex flex-col border-l border-foreground/5 pl-2">
                                <span className="text-xs text-foreground/40 mb-1">{isReviewCompleted ? (dict?.dashboard?.premiumCard?.approved || 'Approved') : (dict?.dashboard?.premiumCard?.reviewed || 'Reviewed')}</span>
                                <span className={`text-2xl font-light tracking-tighter ${isReviewCompleted ? 'text-emerald-500/80 drop-shadow-[0_0_10px_rgba(16,185,129,0.5)]' : 'text-blue-500/80'}`}>
                                    {isReviewCompleted && stages.approved !== undefined ? stages.approved : stages.reviewed}
                                </span>
                            </div>
                        </div>
                    ) : (
                        <div className="text-xs text-foreground/40 mt-1 mb-4">{dict?.dashboard?.premiumCard?.noData || 'No data available'}</div>
                    )}
                </CardContent>
            </Link>

            {active && (
                <div className="px-6 pb-6 flex flex-col gap-3">
                    <div className="flex items-center justify-between gap-2">
                        <div className="flex gap-2">
                            <button
                                onClick={onRunPipeline}
                                disabled={isRunning}
                                className="text-xs px-2 py-1 rounded flex items-center gap-1 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/20 transition-colors z-10 relative disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {isRunning && <Loader2 className="w-3 h-3 animate-spin" />}
                                {dict?.dashboard?.premiumCard?.runPipeline || 'Run Pipeline'}
                            </button>
                            {stages && stages.preprocessed > 0 && stages.reviewed === 0 && !isReviewCompleted && (
                                <button
                                    onClick={onRunAiOnly}
                                    disabled={isRunning}
                                    className="text-xs px-2 py-1 rounded flex items-center gap-1 bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 border border-blue-500/20 transition-colors z-10 relative disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {isRunning && <Loader2 className="w-3 h-3 animate-spin" />}
                                    {dict?.dashboard?.premiumCard?.runAiOnly || 'Run AI Review'}
                                </button>
                            )}
                        </div>
                        {isReviewCompleted && (
                            <div className="flex items-center gap-1.5 px-2.5 py-1 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-full shadow-[0_0_10px_rgba(16,185,129,0.1)] relative z-10">
                                <CheckCircle2 className="w-3.5 h-3.5" />
                                <span className="text-[10px] font-bold uppercase tracking-wider">{dict?.dashboard?.premiumCard?.reviewCompleted || 'Review Completed'}</span>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </Card>
    );
}
