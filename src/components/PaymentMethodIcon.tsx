/**
 * components/PaymentMethodIcon — v63 (الجولة 75 #3): أيقونات هوية
 * حقيقية لكل بنك ومحفظة (أندرويد).
 * ─────────────────────────────────────────────────────────────────
 * طلب التاجر نصاً: «جلب ايقونات المحافظ والبنوك الخاصة بكل محفظة
 * أو بنك حتي يميزها المستخدم بسهولة».
 *
 * نفس هوية سطح المكتب v71: رسم SVG أصلي (react-native-svg) بلون
 * العلامة الرسمي + عنصرها المميز + اسمها بخط Tajawal المدمج:
 *   • جوال باي — التدرج البرتقالي الأحمر + «جوال باي».
 *   • بال باي — الأزرق + PalPay.
 *   • مال تشات — البنفسجي + فقاعة محادثة فيها ₪.
 *   • بنك فلسطين — الأحمر + «فلسطين» وقوس معماري.
 *   • بنك القدس — التيلي + قبة ذهبية.
 *   • البنك الإسلامي — الأخضر + هلال ونجمة.
 */
import React from 'react';
import {Image, StyleSheet, View} from 'react-native';
import Svg, {Defs, LinearGradient, Path, Rect, Circle, Stop, Text} from 'react-native-svg';
import type {PaymentMethod} from '../core/paymentMethods';
/* v65 (الجولة 77 — ملاحظة التاجر الأخيرة): الشعارات الرسمية
 * الحقيقية — أيقونات التطبيقات المنشورة على Google Play لكل بنك
 * ومحفظة فلسطينية، بدل الرسوم التقريبية. */
import bankPalestineLogo from '../assets/pm-logos/bank_palestine.png';
import bankQudsLogo from '../assets/pm-logos/bank_quds.png';
import bankIslamiLogo from '../assets/pm-logos/bank_islami.png';
import jawwalPayLogo from '../assets/pm-logos/jawwal_pay.png';
import palPayLogo from '../assets/pm-logos/palpay.png';
import malchatLogo from '../assets/pm-logos/malchat.png';

function CashIcon({size}: {size: number}): React.ReactElement {
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48">
      <Rect width="48" height="48" rx="10" fill="#16A34A" />
      <Rect
        x="7"
        y="14"
        width="34"
        height="20"
        rx="3.5"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="2.4"
      />
      <Circle cx="24" cy="24" r="6.5" fill="#FFFFFF" />
      <Text
        x="24"
        y="27.6"
        textAnchor="middle"
        fontFamily="Tajawal"
        fontWeight="800"
        fontSize="10.5"
        fill="#16A34A">
        ₪
      </Text>
    </Svg>
  );
}

function JawwalPayIcon({size}: {size: number}): React.ReactElement {
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48">
      <Defs>
        <LinearGradient id="selaJpGrad" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#F7941D" />
          <Stop offset="1" stopColor="#ED1C24" />
        </LinearGradient>
      </Defs>
      <Rect width="48" height="48" rx="10" fill="url(#selaJpGrad)" />
      <Path
        d="M10 31.5c4.5-13 14-17.5 23-13.5-6.5.5-12.5 4.5-15.5 11-1.2 2.6-4.2 4.6-7.5 2.5z"
        fill="#FFFFFF"
        opacity="0.28"
      />
      <Text
        x="24"
        y="21.5"
        textAnchor="middle"
        fontFamily="Tajawal"
        fontWeight="800"
        fontSize="11.5"
        fill="#FFFFFF">
        جوال
      </Text>
      <Text
        x="24"
        y="35"
        textAnchor="middle"
        fontFamily="Tajawal"
        fontWeight="800"
        fontSize="11.5"
        fill="#FFFFFF">
        باي
      </Text>
    </Svg>
  );
}

function PalPayIcon({size}: {size: number}): React.ReactElement {
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48">
      <Rect width="48" height="48" rx="10" fill="#0B5FA5" />
      <Circle cx="38.5" cy="10" r="9" fill="#5BC2E7" opacity="0.9" />
      <Text
        x="23"
        y="29.5"
        textAnchor="middle"
        fontFamily="Tajawal"
        fontStyle="italic"
        fontWeight="800"
        fontSize="13"
        fill="#FFFFFF">
        PalPay
      </Text>
      <Text
        x="23"
        y="40"
        textAnchor="middle"
        fontFamily="Tajawal"
        fontWeight="700"
        fontSize="8"
        fill="#BBE3F5">
        بال باي
      </Text>
    </Svg>
  );
}

function MalChatIcon({size}: {size: number}): React.ReactElement {
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48">
      <Rect width="48" height="48" rx="10" fill="#6D28B9" />
      <Path
        d="M24 9.5c-8.6 0-15.5 5.6-15.5 12.6 0 4 2.3 7.5 5.9 9.8-.4 2-1.5 3.9-3.2 5.4 2.9.1 5.7-1 8-3 1.5.3 3.1.5 4.8.5 8.6 0 15.5-5.6 15.5-12.7S32.6 9.5 24 9.5z"
        fill="#FFFFFF"
      />
      <Text
        x="24"
        y="26.5"
        textAnchor="middle"
        fontFamily="Tajawal"
        fontWeight="800"
        fontSize="12"
        fill="#6D28B9">
        ₪
      </Text>
    </Svg>
  );
}

function BankPalestineIcon({size}: {size: number}): React.ReactElement {
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48">
      <Rect width="48" height="48" rx="10" fill="#D32011" />
      <Path
        d="M8 38c0-9 7-16.5 16-16.5S40 29 40 38h-5.2c0-6.3-4.8-11.3-10.8-11.3S13.2 31.7 13.2 38z"
        fill="#FFFFFF"
        opacity="0.22"
      />
      <Text
        x="24"
        y="26"
        textAnchor="middle"
        fontFamily="Tajawal"
        fontWeight="800"
        fontSize="12.5"
        fill="#FFFFFF">
        فلسطين
      </Text>
      <Text
        x="24"
        y="38.5"
        textAnchor="middle"
        fontFamily="Tajawal"
        fontWeight="700"
        fontSize="7.5"
        fill="#FFD9D4">
        بنك
      </Text>
    </Svg>
  );
}

function BankQudsIcon({size}: {size: number}): React.ReactElement {
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48">
      <Rect width="48" height="48" rx="10" fill="#0E6E5C" />
      <Path
        d="M24 8.5c-6.2 0-11.2 4.4-11.2 9.9h22.4C35.2 12.9 30.2 8.5 24 8.5z"
        fill="#E8B23A"
      />
      <Rect x="11.5" y="20.4" width="25" height="2.6" fill="#E8B23A" />
      <Rect x="13" y="24" width="22" height="7" fill="#F5F1E6" opacity="0.95" />
      <Rect x="10.5" y="32" width="27" height="2.8" fill="#E8B23A" />
      <Rect x="8.5" y="36.4" width="31" height="3.1" fill="#FFFFFF" opacity="0.85" />
    </Svg>
  );
}

function BankIslamiIcon({size}: {size: number}): React.ReactElement {
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48">
      <Rect width="48" height="48" rx="10" fill="#0E8A4A" />
      <Path
        d="M30.5 24a9.5 9.5 0 1 1-8.9-12.6 7.6 7.6 0 1 0 0 18.2A9.6 9.6 0 0 1 30.5 24z"
        fill="#FFFFFF"
      />
      <Path
        d="M31 13.6l1.4 3.1 3.4.4-2.5 2.3.7 3.3-3-1.7-3 1.7.7-3.3-2.5-2.3 3.4-.4z"
        fill="#F5D061"
      />
    </Svg>
  );
}

function OtherMethodIcon({size}: {size: number}): React.ReactElement {
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48">
      <Rect width="48" height="48" rx="10" fill="#6B7280" />
      <Rect
        x="12"
        y="16"
        width="24"
        height="16"
        rx="3"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="2.2"
      />
      <Circle cx="24" cy="24" r="3" fill="#FFFFFF" />
    </Svg>
  );
}

const ICONS: Record<string, (props: {size: number}) => React.ReactElement> = {
  cash: CashIcon,
  jawwal_pay: JawwalPayIcon,
  palpay: PalPayIcon,
  malchat: MalChatIcon,
  bank_palestine: BankPalestineIcon,
  bank_quds: BankQudsIcon,
  bank_islami: BankIslamiIcon,
  other: OtherMethodIcon,
  card: OtherMethodIcon,
};

/** أي كيان شبيه بطريقة دفع (يقبل العرض التاريخي «أخرى/بطاقة»). */
export type PaymentIconMethod = {id: string; label: string};

export function PaymentMethodIcon({
  method,
  size = 34,
}: {
  method: PaymentIconMethod | PaymentMethod;
  size?: number;
}): React.ReactElement {
  const logo = REAL_LOGOS[method.id];
  if (logo != null) {
    // رقاقة بيضاء مستديرة تحمل الشعار الرسمي — نمط أنظمة الدفع
    // العالمية، ويُبقي الشعار مقروءاً على الوضعين الليلي والنهاري.
    return (
      <View
        style={[
          styles.logoChip,
          {width: size, height: size, borderRadius: size * 0.24},
        ]}>
        <Image
          source={logo}
          style={{width: '100%', height: '100%', borderRadius: size * 0.16}}
          resizeMode="cover"
        />
      </View>
    );
  }
  const IconCmp = ICONS[method.id] ?? CashIcon;
  return <IconCmp size={size} />;
}

/** خريطة الشعارات الرسمية (أيقونات Google Play الرسمية). */
const REAL_LOGOS: Record<string, number> = {
  bank_palestine: bankPalestineLogo,
  bank_quds: bankQudsLogo,
  bank_islami: bankIslamiLogo,
  jawwal_pay: jawwalPayLogo,
  palpay: palPayLogo,
  malchat: malchatLogo,
};

const styles = StyleSheet.create({
  logoChip: {
    backgroundColor: '#FFFFFF',
    /* v68 (الجولة 80 #٤أ): الحشوة 2→1 — الشعارات الرسمية قُصّت
       حوافها المدمجة (نفس ملفات سطح المكتب) فصارت تملأ إطارها
       بالكامل بدل أن «يبدو صغيراً في اطار الصورة». */
    padding: 1,
    overflow: 'hidden',
    elevation: 2,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 3,
    shadowOffset: {width: 0, height: 1},
  },
});
