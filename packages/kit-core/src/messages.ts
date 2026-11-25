/**
 * What the OWNER reads (contract §8 «الأخطاء بلغة العميل»): plain Egyptian Arabic, what happened and what to press — never a status code.
 * Connectors add their own codes by passing `extra`.
 */
export interface OwnerMessage {
  text: string;
  /** The button the screen shows next to the message, when there is something the owner can do. */
  action?: 'update_credentials' | 'reconnect' | 'retry' | 'map_items' | 'none';
}

const BASE: Record<string, OwnerMessage> = {
  auth_failed: { text: 'بيانات الربط اتغيّرت أو اتلغت من عند المنصة. حدّث البيانات عشان الشغل يكمّل.', action: 'update_credentials' },
  rate_limited: { text: 'المنصة طالبة نهدّى شوية. هنكمّل لوحدنا بعد دقايق، مش مطلوب منك حاجة.', action: 'none' },
  platform_unavailable: { text: 'المنصة مش بترد دلوقتي. كل حاجة محفوظة وهتتبعت أول ما ترجع، مش مطلوب منك حاجة.', action: 'none' },
  circuit_open: { text: 'المنصة بتفشل كذا مرة ورا بعض، فوقفنا المحاولة شوية. هنرجع نحاول لوحدنا.', action: 'none' },
  timeout: { text: 'المنصة اتأخرت في الرد. هنحاول تاني لوحدنا.', action: 'none' },
  network: { text: 'مفيش اتصال بالمنصة دلوقتي. هنحاول تاني لوحدنا.', action: 'none' },
  rejected: { text: 'المنصة رفضت الطلب ده. راجع التفاصيل أو اضغط «إعادة المحاولة» بعد التعديل.', action: 'retry' },
  not_found: { text: 'المنصة مش لاقية الحاجة دي عندها. راجع الربط.', action: 'reconnect' },
  exhausted: { text: 'حاولنا كتير ومنفعش. اضغط «إعادة المحاولة» أو كلّمنا.', action: 'retry' },
  unexpected: { text: 'حصل خطأ غير متوقع. هنحاول تاني لوحدنا، ولو استمر هنبلّغك.', action: 'none' },
  host_not_allowed: { text: 'عنوان المنصة مش مسموح. كلّمنا.', action: 'none' },
  item_not_mapped: { text: 'فيه صنف جاي من المنصة مش مربوط بصنف عندك. اربطه عشان الطلبات تدخل المطبخ.', action: 'map_items' },
};

export function ownerMessage(code: string, extra: Record<string, OwnerMessage> = {}): OwnerMessage {
  return extra[code] ?? BASE[code] ?? BASE.unexpected!;
}
