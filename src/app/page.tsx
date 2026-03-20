import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import Link from 'next/link';
import { Database, Bot, CheckCircle, Archive, Server, Component, DatabaseZap, Network, HardDrive, Cpu, Activity } from "lucide-react";
import { getDictionary, Locale } from "@/lib/i18n";
import { cookies } from "next/headers";

// 카테고리 정적 메타데이터. count는 서버 렌더링 시 API 응답으로 덮어쓰여지므로 초기값은 의미 없음.
// active: false인 카테고리는 클릭 불가 상태로 표시된다.
const CATEGORIES: { id: string, count: string | number, active: boolean, icon: any }[] = [
  { id: 'os', count: 124, active: true, icon: Server },
  { id: 'middleware', count: 0, active: true, icon: Component },
  { id: 'database', count: 0, active: true, icon: DatabaseZap },
  { id: 'network', count: 0, active: false, icon: Network },
  { id: 'storage', count: 0, active: true, icon: HardDrive },
  { id: 'virtualization', count: 0, active: true, icon: Cpu },
];

// SSR(Server-Side Rendering) 대시보드 홈 페이지.
// 매 요청마다 pipeline 상태, 카테고리별 제품 수, 아카이브 수를 API로 조회해 렌더링한다.
// cache: 'no-store'로 항상 최신 데이터를 사용한다.
export default async function Home() {
  const port = process.env.PORT || 3001;
  const baseUrl = `http://localhost:${port}`;

  const cookieStore = await cookies();
  const locale = (cookieStore.get('NEXT_LOCALE')?.value || 'ko') as Locale;
  const dict = getDictionary(locale);

  let pipeline: any = null;
  let osReviewCountSum: string | number = "0/7"; // Default fallback
  let storageReviewCountSum: string | number = "0/1"; // Default fallback
  let databaseReviewCountSum: string | number = "0/4"; // Default fallback
  let virtualizationReviewCountSum: string | number = "0/1"; // Default fallback
  let middlewareReviewCountSum: string | number = "0/1"; // Default fallback
  let osCustomDesc = '';
  let storageCustomDesc = '';
  let databaseCustomDesc = '';
  let virtualizationCustomDesc = '';
  let middlewareCustomDesc = '';

  // Statistics Aggregation Variables
  let totalCollected = 0;
  let totalReviewed = 0;
  let totalApproved = 0;
  let archiveCount = 0;

  try {
    const res = await fetch(`${baseUrl}/api/pipeline`, { cache: 'no-store' });
    if (res.ok) {
      pipeline = await res.json();
    }

    // 카테고리별 제품 목록에서 전체 통계(수집/리뷰/승인 수)를 누적한다.
    // 각 카테고리 API를 순차적으로 호출하며 공통 카운터에 합산한다.
    const aggregateStats = (products: any[]) => {
      let catApproved = 0;
      products.forEach((p: any) => {
        if (p.stages) {
          totalCollected += p.stages.collected || 0;
          totalReviewed += p.stages.reviewed || 0;
          totalApproved += p.stages.approved || 0;
          catApproved += p.stages.approved || 0;
        }
      });
      return catApproved;
    };

    // Fetch OS Products Data
    const prodRes = await fetch(`${baseUrl}/api/products?category=os`, { cache: 'no-store' });
    if (prodRes.ok) {
      const prodData = await prodRes.json();
      const products = prodData.products || [];
      const activeProducts = products.filter((p: any) => p.active);
      const completedProducts = activeProducts.filter((p: any) => p.isReviewCompleted);
      
      const catApproved = aggregateStats(products);
      osReviewCountSum = `${completedProducts.length}/${products.length}`;
      const patchRatioStr = catApproved > 0 ? ` | ${catApproved} ${dict.dashboard.patchesReviewed}` : '';
      osCustomDesc = `${dict.dashboard.productsReviewed}${patchRatioStr}`;
    }

    // Fetch Storage Products Data
    const storageRes = await fetch(`${baseUrl}/api/products?category=storage`, { cache: 'no-store' });
    if (storageRes.ok) {
      const prodData = await storageRes.json();
      const products = prodData.products || [];
      const activeProducts = products.filter((p: any) => p.active);
      const completedProducts = activeProducts.filter((p: any) => p.isReviewCompleted);
      
      const catApproved = aggregateStats(products);
      storageReviewCountSum = `${completedProducts.length}/${products.length}`;
      const patchRatioStr = catApproved > 0 ? ` | ${catApproved} ${dict.dashboard.patchesReviewed}` : '';
      storageCustomDesc = `${dict.dashboard.productsReviewed}${patchRatioStr}`;
    }

    // Fetch Database Products Data
    const databaseRes = await fetch(`${baseUrl}/api/products?category=database`, { cache: 'no-store' });
    if (databaseRes.ok) {
      const prodData = await databaseRes.json();
      const products = prodData.products || [];
      const activeProducts = products.filter((p: any) => p.active);
      const completedProducts = activeProducts.filter((p: any) => p.isReviewCompleted);
      
      const catApproved = aggregateStats(products);
      databaseReviewCountSum = `${completedProducts.length}/${products.length}`;
      const patchRatioStr = catApproved > 0 ? ` | ${catApproved} ${dict.dashboard.patchesReviewed}` : '';
      databaseCustomDesc = `${dict.dashboard.productsReviewed}${patchRatioStr}`;
    }

    // Fetch Virtualization Products Data
    const virtualizationRes = await fetch(`${baseUrl}/api/products?category=virtualization`, { cache: 'no-store' });
    if (virtualizationRes.ok) {
      const prodData = await virtualizationRes.json();
      const products = prodData.products || [];
      const activeProducts = products.filter((p: any) => p.active);
      const completedProducts = activeProducts.filter((p: any) => p.isReviewCompleted);

      const catApproved = aggregateStats(products);
      virtualizationReviewCountSum = `${completedProducts.length}/${products.length}`;
      const patchRatioStr = catApproved > 0 ? ` | ${catApproved} ${dict.dashboard.patchesReviewed}` : '';
      virtualizationCustomDesc = `${dict.dashboard.productsReviewed}${patchRatioStr}`;
    }

    // Fetch Middleware Products Data
    const middlewareRes = await fetch(`${baseUrl}/api/products?category=middleware`, { cache: 'no-store' });
    if (middlewareRes.ok) {
      const prodData = await middlewareRes.json();
      const products = prodData.products || [];
      const activeProducts = products.filter((p: any) => p.active);
      const completedProducts = activeProducts.filter((p: any) => p.isReviewCompleted);

      const catApproved = aggregateStats(products);
      middlewareReviewCountSum = `${completedProducts.length}/${products.length}`;
      const patchRatioStr = catApproved > 0 ? ` | ${catApproved} ${dict.dashboard.patchesReviewed}` : '';
      middlewareCustomDesc = `${dict.dashboard.productsReviewed}${patchRatioStr}`;
    }

    // Fetch Archives Data for Stats (quarterly archives)
    const arcRes = await fetch(`${baseUrl}/api/archive/quarterly`, { cache: 'no-store' });
    if (arcRes.ok) {
      const arcData = await arcRes.json();
      archiveCount = (arcData.quarters || []).length;
    }

  } catch (error) {
    console.error("Failed to fetch dashboard data:", error);
  }

  // 정적 카테고리 메타데이터에 API에서 조회한 동적 count와 i18n 이름을 합쳐 렌더링용 배열을 만든다.
  const dynamicCategories = CATEGORIES.map(cat => {
    let name = cat.id; // Fallback
    switch (cat.id) {
      case 'os': name = dict.dashboard.categoryTitlePrefix + 'OS' + dict.dashboard.categoryTitleSuffix; break;
      case 'middleware': name = dict.dashboard.categoryTitlePrefix + 'Middleware' + dict.dashboard.categoryTitleSuffix; break;
      case 'database': name = dict.dashboard.categoryTitlePrefix + 'Database' + dict.dashboard.categoryTitleSuffix; break;
      case 'network': name = dict.dashboard.categoryTitlePrefix + 'Network' + dict.dashboard.categoryTitleSuffix; break;
      case 'storage': name = dict.dashboard.categoryTitlePrefix + 'Storage' + dict.dashboard.categoryTitleSuffix; break;
      case 'virtualization': name = dict.dashboard.categoryTitlePrefix + 'Virtualization' + dict.dashboard.categoryTitleSuffix; break;
    }

    if (cat.id === 'os') {
      return { ...cat, name, count: osReviewCountSum, customDesc: osCustomDesc };
    } else if (cat.id === 'storage') {
      return { ...cat, name, count: storageReviewCountSum, customDesc: storageCustomDesc };
    } else if (cat.id === 'database') {
      return { ...cat, name, count: databaseReviewCountSum, customDesc: databaseCustomDesc };
    } else if (cat.id === 'virtualization') {
      return { ...cat, name, count: virtualizationReviewCountSum, customDesc: virtualizationCustomDesc };
    } else if (cat.id === 'middleware') {
      return { ...cat, name, count: middlewareReviewCountSum, customDesc: middlewareCustomDesc };
    }
    return { ...cat, name };
  });

  return (
    <div className="min-h-screen bg-background p-6 lg:p-12 font-sans selection:bg-primary/20">
      <div className="max-w-7xl mx-auto space-y-12 animate-in fade-in duration-700">

        {/* Header Section */}
        <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <h1 className="text-3xl md:text-5xl font-bold tracking-tight text-foreground/90">{dict.dashboard.title}</h1>
            <p className="text-foreground/50 text-sm md:text-base mt-2">{dict.dashboard.subtitle}</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 shadow-[0_0_15px_rgba(16,185,129,0.1)]">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
              <span className="text-xs font-semibold text-emerald-400 uppercase tracking-widest">{dict.dashboard.pipelineActive}</span>
            </span>
            <Badge variant="outline" className="border-foreground/10 text-foreground/50 hover:bg-foreground/10 px-4 py-1.5 font-medium transition-colors">
              {pipeline?.quarter || "Q1 2026"}
            </Badge>
          </div>
        </header>

        {/* Global Statistics Section Wrapped in a Panel */}
        <section className="relative p-6 md:p-8 rounded-2xl border border-border bg-gradient-to-b from-foreground/[0.03] to-transparent overflow-hidden shadow-2xl">
          <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-emerald-500/5 rounded-full blur-[120px] -mr-48 -mt-48 pointer-events-none"></div>

          <div className="flex flex-col gap-8 relative z-10">
            <div className="flex items-center justify-between">
              <h2 className="text-lg md:text-xl font-bold text-foreground/90 flex items-center gap-3 tracking-wide">
                <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                  <Activity className="w-5 h-5 text-emerald-400" />
                </div>
                {dict.dashboard.globalOverview}
              </h2>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard title={dict.dashboard.stats.collectedTitle} value={totalCollected} icon={Database} description={dict.dashboard.stats.collectedDesc} colorClass="text-blue-400" />
              <StatCard title={dict.dashboard.stats.reviewedTitle} value={totalReviewed} icon={Bot} description={dict.dashboard.stats.reviewedDesc} colorClass="text-purple-400" />
              <StatCard title={dict.dashboard.stats.approvedTitle} value={totalApproved} icon={CheckCircle} description={dict.dashboard.stats.approvedDesc} colorClass="text-emerald-400" />
              <StatCard title={dict.dashboard.stats.archivesTitle} value={archiveCount} icon={Archive} description={dict.dashboard.stats.archivesDesc} colorClass="text-amber-400" />
            </div>
          </div>
        </section>

        {/* Categories Separator */}
        <div className="flex items-center gap-6 pt-4">
          <h2 className="text-sm font-semibold text-foreground/50 uppercase tracking-[0.2em]">{dict.dashboard.categoriesConfig}</h2>
          <div className="h-px flex-1 bg-gradient-to-r from-foreground/10 to-transparent"></div>
        </div>

        {/* Categories Grid */}
        <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {dynamicCategories.map((cat: any) => (
            <Link href={`/category/${cat.id}`} key={cat.id}>
              <CategoryCard
                title={cat.name}
                value={cat.count?.toString() || "0"}
                desc={cat.customDesc || (cat.active ? dict.dashboard.clickToViewProducts : dict.dashboard.inactiveTarget)}
                active={cat.active}
                Icon={cat.icon}
              />
            </Link>
          ))}
        </section>

      </div>
    </div>
  );
}

function StatCard({ title, value, description, icon: Icon, colorClass }: { title: string, value: number, description: string, icon: any, colorClass: string }) {
  return (
    <Card className="relative overflow-hidden border-border bg-card transition-all duration-300 hover:border-foreground/20 hover:bg-foreground/[0.02]">
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <CardTitle className="text-xs font-semibold text-foreground/60 uppercase tracking-wider">{title}</CardTitle>
        <div className={`p-2 rounded-lg bg-foreground/[0.05] ${colorClass}`}>
          <Icon className="w-4 h-4 opacity-80" />
        </div>
      </CardHeader>
      <CardContent>
        <div className="text-4xl font-light tracking-tighter text-foreground mb-2">{value.toLocaleString()}</div>
        <p className="text-[10px] text-foreground/40 uppercase tracking-wide">{description}</p>
      </CardContent>
    </Card>
  );
}

function CategoryCard({ title, value, desc, active, Icon }: { title: string, value: string, desc: string, active: boolean, Icon: any }) {
  return (
    <Card className={`group relative overflow-hidden cursor-pointer border-border bg-card transition-all duration-500 ${active ? 'hover:-translate-y-1 hover:border-emerald-500/30 hover:bg-foreground/[0.04] hover:shadow-[0_10px_40px_-10px_rgba(16,185,129,0.1)]' : 'opacity-40 grayscale hover:opacity-60'}`}>
      <div className={`absolute top-0 right-0 w-32 h-32 rounded-full blur-[50px] -mr-16 -mt-16 pointer-events-none transition-opacity duration-500 ${active ? 'bg-emerald-500/10 opacity-0 group-hover:opacity-100' : 'bg-transparent'}`}></div>
      <CardHeader className="pb-3 flex flex-row items-center gap-3">
        <div className={`p-2.5 rounded-xl border ${active ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-500' : 'bg-foreground/5 border-foreground/10 text-foreground/40'}`}>
          <Icon className="w-5 h-5" />
        </div>
        <CardTitle className="text-sm font-semibold text-foreground/80 tracking-wide">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-light tracking-tighter text-foreground/90">{value}</div>
        <p className="text-xs text-foreground/50 mt-2 font-mono">{desc}</p>
      </CardContent>
    </Card>
  );
}

