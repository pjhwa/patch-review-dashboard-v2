import { getDictionary, Locale } from "@/lib/i18n";
import { cookies } from "next/headers";
import { ProductDetailClient } from "./ClientPage";

export default async function ProductDetailPage({ params }: { params: Promise<{ categoryId: string, productId: string }> }) {
    const { categoryId, productId } = await params;

    // Setup i18n safely on the Server
    const cookieStore = await cookies();
    const locale = (cookieStore.get('NEXT_LOCALE')?.value || 'ko') as Locale;
    const dict = getDictionary(locale);

    return <ProductDetailClient categoryId={categoryId} productId={productId} dict={dict} />;
}
