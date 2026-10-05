/**
 * NotificationsScreen — مركز الإشعارات (design.md §9.8).
 */
import React, {useEffect} from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import {AppHeader, Badge, EmptyState} from '../components/ui';
import {Icon, IconChip, type IconName} from '../components/Icon';
import {useNotificationsStore} from '../stores/notificationsStore';
import {
  fonts,
  makeStyles,
  radius,
  spacing,
  typography,
  useThemeColors,
  type Palette,
} from '../core/theme';
import {relativeTime} from '../core/format';
import type {NotificationKind} from '../core/types';

function kindMeta(kind: NotificationKind, c: Palette) {
  const map: Record<
    NotificationKind,
    {icon: IconName; bg: string; color: string; label: string}
  > = {
    out_of_stock: {
      icon: 'packageMinus',
      bg: c.dangerSoft,
      color: c.danger,
      label: 'نفاد مخزون',
    },
    low_stock: {
      icon: 'alert',
      bg: c.warningSoft,
      color: c.warning,
      label: 'مخزون منخفض',
    },
    info: {icon: 'info', bg: c.infoSoft, color: c.info, label: 'معلومة'},
    printer: {
      icon: 'printer',
      bg: c.accentSoft,
      color: c.accent,
      label: 'طابعة',
    },
    sale: {icon: 'cart', bg: c.successSoft, color: c.success, label: 'مبيعات'},
    stocktake: {icon: 'clipboard', bg: c.infoSoft, color: c.info, label: 'جرد'},
    sila_debt: {
      icon: 'qrFrame',
      bg: c.warningSoft,
      color: c.warning,
      label: 'دين صِلة',
    },
  };
  return map[kind] ?? map.info;
}

export function NotificationsScreen() {
  const c = useThemeColors();
  const styles = useStyles();
  const navigation = useNavigation<any>();
  const items = useNotificationsStore(state => state.items);
  const unreadCount = useNotificationsStore(state => state.unreadCount);
  const markAllRead = useNotificationsStore(state => state.markAllRead);
  const markRead = useNotificationsStore(state => state.markRead);
  const clearAll = useNotificationsStore(state => state.clearAll);

  // Mark everything read once the center is opened.
  useEffect(() => {
    if (unreadCount > 0) {
      const timer = setTimeout(() => markAllRead(), 900);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [unreadCount, markAllRead]);

  return (
    <View style={styles.screen}>
      <AppHeader
        title="الإشعارات"
        subtitle={items.length > 0 ? `${items.length} إشعار` : undefined}
        showBack
        showBell={false}
        right={
          items.length > 0 ? (
            <TouchableOpacity
              onPress={clearAll}
              hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
              <Text style={styles.clearAll}>مسح الكل</Text>
            </TouchableOpacity>
          ) : undefined
        }
      />

      {items.length === 0 ? (
        <EmptyState
          icon="bellOff"
          title="لا توجد إشعارات"
          subtitle="ستظهر هنا تنبيهات نفاد المخزون وانخفاضه وأخبار الطابعة"
        />
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}>
          {items.map(item => {
            const meta = kindMeta(item.kind, c);
            return (
              <TouchableOpacity
                key={item.id}
                style={[styles.row, !item.read && styles.rowUnread]}
                activeOpacity={0.8}
                onPress={() => {
                  markRead(item.id);
                  if (item.productId != null) {
                    navigation.navigate('ProductForm', {
                      productId: item.productId,
                    });
                  }
                }}>
                <IconChip
                  name={meta.icon}
                  chipSize={42}
                  size={19}
                  bg={meta.bg}
                  color={meta.color}
                />
                <View style={{flex: 1}}>
                  <View style={styles.rowHead}>
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      {item.title}
                    </Text>
                    {!item.read ? <View style={styles.unreadDot} /> : null}
                  </View>
                  <Text style={styles.rowBody} numberOfLines={2}>
                    {item.body}
                  </Text>
                  <View style={styles.rowFoot}>
                    <Badge label={meta.label} tone="neutral" />
                    <Text style={styles.rowTime}>
                      {relativeTime(item.createdAt)}
                    </Text>
                  </View>
                  {item.productId != null ? (
                    <View style={styles.rowAction}>
                      <Icon name="chevronLeft" size={13} color={c.accent} />
                      <Text style={styles.rowActionText}>عرض المنتج</Text>
                    </View>
                  ) : null}
                </View>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

const useStyles = makeStyles(c =>
  StyleSheet.create({
    screen: {flex: 1, backgroundColor: c.bg},
    content: {
      padding: spacing.lg,
      gap: spacing.sm,
      paddingBottom: spacing.xxl,
    },
    clearAll: {
      color: c.danger,
      fontFamily: fonts.bold,
      fontSize: typography.small,
      paddingHorizontal: spacing.sm,
    },
    row: {
      flexDirection: 'row',
      gap: spacing.md,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderSoft,
      borderRadius: radius.md,
      padding: spacing.md,
    },
    rowUnread: {
      borderColor: c.accentDark,
      backgroundColor: c.surface,
    },
    rowHead: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    rowTitle: {
      flex: 1,
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.caption,
    },
    unreadDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: c.accent,
    },
    rowBody: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      lineHeight: 19,
      marginTop: 3,
    },
    rowFoot: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginTop: 7,
    },
    rowTime: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
    },
    rowAction: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      marginTop: 6,
    },
    rowActionText: {
      color: c.accent,
      fontFamily: fonts.bold,
      fontSize: typography.micro + 1,
    },
  }),
);
