/**
 * DriveBackupScreen — v28 (round-36 #4) النسخ الاحتياطي السحابي.
 * ─────────────────────────────────────────────────────────────────
 * الصفحة الخاصة بنسخ Google Drive التي طلبها التاجر بالضبط:
 *
 *   • ربط حساب جوجل درايف لمرة واحدة (دليل إعداد مضمن خطوة بخطوة
 *     + لصق Client ID / Secret من حساب التاجر نفسه).
 *   • رفع تلقائي كل فترة بالأيام يحددها المستخدم — يرفع مباشرة
 *     متى انقضت المدة وتوفر إنترنت (فحص عند الإقلاع وكل ربع ساعة).
 *   • عرض كل النسخ المرفوعة على الدرايف مع الحجم والتاريخ.
 *   • استرجاع آخر نسخة مرفوعة أو أي نسخة مختارة — بنفس مسار
 *     الاسترجاع المحلي تماماً (تأكيد بالأعداد ثم معاملة واحدة).
 *
 * تصميم عملي: بطاقة حالة الربط أولاً، ثم الإعداد التلقائي، ثم
 * الرفع اليدوي، فقائمة النسخ، وأخيراً سجل الرفع المحلي.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import {
  AppButton,
  AppHeader,
  Badge,
  Card,
  EmptyState,
  SectionTitle,
  Segmented,
  SwitchRow,
} from '../../components/ui';
import {Icon} from '../../components/Icon';
import {
  fonts,
  makeStyles,
  radius,
  spacing,
  typography,
  useThemeColors,
} from '../../core/theme';
import {formatDateTime, relativeTime} from '../../core/format';
import {useCatalogStore} from '../../stores/catalogStore';
import {useSilaStore} from '../../stores/silaStore';
import {useToastStore} from '../../stores/toastStore';
import {BackupService} from '../../services/BackupService';
import {
  DriveConfig,
  GoogleDriveService,
  DRIVE_FOLDER_NAME,
  type DriveBackupFile,
  type DriveHistoryEntry,
} from '../../services/GoogleDriveService';

/** فترات الرفع التلقائي (بالأيام). */
const INTERVAL_OPTIONS: {value: number; label: string}[] = [
  {value: 1, label: 'يومياً'},
  {value: 3, label: 'كل 3 أيام'},
  {value: 7, label: 'أسبوعياً'},
  {value: 14, label: 'كل 14 يوماً'},
  {value: 30, label: 'شهرياً'},
];

/** روابط إعداد جوجل (تفتح في المتصفح). */
const SETUP_LINKS = {
  project: 'https://console.cloud.google.com/projectcreate',
  driveApi: 'https://console.cloud.google.com/apis/library/drive.googleapis.com',
  consent: 'https://console.cloud.google.com/apis/credentials/consent',
  credentials:
    'https://console.cloud.google.com/apis/credentials/oauthclient',
};

/** ms timestamp → 'YYYY-MM-DD HH:MM:SS' محلي (لـ formatDateTime). */
function msToLocalString(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return '';
  }
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** حجم مقروء: بايت / ك.ب / م.ب. */
function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '—';
  }
  if (bytes < 1024) {
    return `${bytes} بايت`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} ك.ب`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} م.ب`;
}

export function DriveBackupScreen() {
  const c = useThemeColors();
  const styles = useStyles();
  const toast = useToastStore(state => state.show);

  // ── Link state (read from MMKV on every focus) ──
  const [connected, setConnected] = useState(false);
  const [email, setEmail] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [intervalDays, setIntervalDays] = useState(3);
  const [lastUploadAt, setLastUploadAt] = useState(0);
  const [history, setHistory] = useState<DriveHistoryEntry[]>([]);

  // ── Busy states ──
  const [connecting, setConnecting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [listing, setListing] = useState(false);
  const [backups, setBackups] = useState<DriveBackupFile[] | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  /** Reload everything from MMKV (called on focus + after actions). */
  const reloadConfig = useCallback(() => {
    setConnected(DriveConfig.isConnected());
    setEmail(DriveConfig.getAccountEmail());
    setClientId(DriveConfig.getClientId());
    setClientSecret(DriveConfig.getClientSecret());
    setAutoEnabled(DriveConfig.getAutoEnabled());
    setIntervalDays(DriveConfig.getAutoIntervalDays());
    setLastUploadAt(DriveConfig.getLastUploadAt());
    setHistory(DriveConfig.getHistory());
  }, []);

  useFocusEffect(
    useCallback(() => {
      reloadConfig();
      if (DriveConfig.isConnected()) {
        void refreshList(true);
      }
    }, [reloadConfig]),
  );

  // ── The Drive list ──
  const refreshList = useCallback(async (silent = false) => {
    if (!DriveConfig.isConnected()) {
      return;
    }
    setListing(!silent);
    try {
      setBackups(await GoogleDriveService.listBackups());
    } catch (error) {
      if (!silent) {
        toast(
          error instanceof Error ? error.message : 'تعذّر قراءة قائمة النسخ',
          'error',
          5000,
        );
      }
    } finally {
      setListing(false);
    }
  }, [toast]);

  // ── Connect / disconnect ──
  const connect = useCallback(async () => {
    if (connecting) {
      return;
    }
    if (clientId.trim().length === 0 || clientSecret.trim().length === 0) {
      toast('الصق Client ID و Client Secret من حساب جوجل أولاً', 'info');
      return;
    }
    DriveConfig.setClientId(clientId);
    DriveConfig.setClientSecret(clientSecret);
    setConnecting(true);
    try {
      const result = await GoogleDriveService.connect();
      reloadConfig();
      toast(
        `تم ربط Google Drive${result.email ? ` — ${result.email}` : ''}`,
        'success',
        5000,
      );
      void refreshList(true);
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'فشل ربط الحساب',
        'error',
        6000,
      );
    } finally {
      setConnecting(false);
    }
  }, [connecting, clientId, clientSecret, reloadConfig, refreshList, toast]);

  const disconnect = useCallback(() => {
    Alert.alert(
      'فصل الربط بجوجل درايف',
      'سيتوقف الرفع التلقائي ولن يستطيع التطبيق الوصول لنسخك على الدرايف (النسخ نفسها تبقى في حسابك). هل تريد المتابعة؟',
      [
        {text: 'إلغاء', style: 'cancel'},
        {
          text: 'فصل الربط',
          style: 'destructive',
          onPress: async () => {
            try {
              await GoogleDriveService.disconnect();
            } catch {
              // Best effort.
            }
            setBackups(null);
            reloadConfig();
            toast('تم فصل الربط بجوجل درايف', 'info');
          },
        },
      ],
    );
  }, [reloadConfig, toast]);

  // ── Auto backup settings ──
  const toggleAuto = useCallback(
    (value: boolean) => {
      DriveConfig.setAutoEnabled(value);
      setAutoEnabled(value);
      if (value) {
        toast(
          'تم تفعيل الرفع التلقائي — تُرفع النسخة متى انقضت المدة وتوفر الإنترنت',
          'success',
          5000,
        );
        // First check right away (never-uploaded → due immediately).
        void GoogleDriveService.maybeAutoBackup().then(outcome => {
          if (outcome === 'uploaded') {
            reloadConfig();
            void refreshList(true);
          }
        });
      }
    },
    [reloadConfig, refreshList, toast],
  );

  const changeInterval = useCallback(
    (value: number) => {
      DriveConfig.setAutoIntervalDays(value);
      setIntervalDays(value);
    },
    [],
  );

  // ── Manual upload ──
  const uploadNow = useCallback(async () => {
    if (uploading) {
      return;
    }
    setUploading(true);
    try {
      const result = await GoogleDriveService.uploadBackup('manual');
      reloadConfig();
      void refreshList(true);
      toast(
        `تم رفع النسخة إلى Google Drive (${formatSize(result.sizeBytes)})`,
        'success',
        6000,
      );
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'فشل رفع النسخة',
        'error',
        6000,
      );
    } finally {
      setUploading(false);
    }
  }, [uploading, reloadConfig, refreshList, toast]);

  // ── Restore (the SAME guarded path as the local restore) ──
  const restoreFrom = useCallback(
    (file: DriveBackupFile) => {
      if (restoringId != null) {
        return;
      }
      Alert.alert(
        'استرجاع نسخة من Google Drive',
        `النسخة: ${file.name}\nتاريخها: ${formatDateTime(msToLocalString(file.createdAtMs))}\nحجمها: ${formatSize(file.sizeBytes)}\n\nسيتم تنزيل النسخة واستبدال كل البيانات الحالية بمحتوياتها. هل تريد المتابعة؟`,
        [
          {text: 'إلغاء', style: 'cancel'},
          {
            text: 'تنزيل واسترجاع',
            style: 'destructive',
            onPress: async () => {
              setRestoringId(file.id);
              try {
                const doc = await GoogleDriveService.downloadBackup(file.id);
                const summary = BackupService.summarize(doc);
                const sila = BackupService.silaCounts(doc);
                setRestoringId(null);
                Alert.alert(
                  'تأكيد الاسترجاع النهائي',
                  `هذه النسخة تحتوي:\n${summary.products} منتج · ${summary.categories} تصنيف · ${summary.units} وحدة\n${summary.embeddings} بصمة بصرية · ${summary.sales} فاتورة\n${sila.debts} دين صِلة · ${sila.payments} إيصال سداد\n\nسيتم استبدال كل البيانات الحالية الآن. متابعة؟`,
                  [
                    {text: 'إلغاء', style: 'cancel'},
                    {
                      text: 'استرجاع الآن',
                      style: 'destructive',
                      onPress: async () => {
                        setRestoringId(file.id);
                        try {
                          const result = await BackupService.restoreBackup(doc);
                          await useCatalogStore.getState().refresh();
                          try {
                            await useSilaStore.getState().refreshCounts();
                          } catch {
                            // Next app start refreshes.
                          }
                          toast(
                            `تم الاسترجاع من درايف — ${result.products} منتج و${result.sales} فاتورة`,
                            'success',
                            7000,
                          );
                        } catch (error) {
                          toast(
                            error instanceof Error
                              ? error.message
                              : 'فشل الاسترجاع — لم تتغير بياناتك',
                            'error',
                            6000,
                          );
                        } finally {
                          setRestoringId(null);
                        }
                      },
                    },
                  ],
                );
              } catch (error) {
                toast(
                  error instanceof Error
                    ? error.message
                    : 'فشل تنزيل النسخة من درايف',
                  'error',
                  6000,
                );
                setRestoringId(null);
              }
            },
          },
        ],
      );
    },
    [restoringId, toast],
  );

  // ── Delete a Drive backup ──
  const deleteFrom = useCallback(
    (file: DriveBackupFile) => {
      Alert.alert(
        'حذف النسخة من درايف',
        `سيتم حذف «${file.name}» نهائياً من Google Drive. متابعة؟`,
        [
          {text: 'إلغاء', style: 'cancel'},
          {
            text: 'حذف',
            style: 'destructive',
            onPress: async () => {
              setDeletingId(file.id);
              try {
                await GoogleDriveService.deleteBackup(file.id);
                toast('تم حذف النسخة من درايف', 'success');
                void refreshList(true);
              } catch (error) {
                toast(
                  error instanceof Error ? error.message : 'فشل حذف النسخة',
                  'error',
                );
              } finally {
                setDeletingId(null);
              }
            },
          },
        ],
      );
    },
    [refreshList, toast],
  );

  const nextDue = useMemo(() => {
    if (!autoEnabled) {
      return null;
    }
    if (lastUploadAt <= 0) {
      return 'أول نسخة عند توفر الإنترنت (خلال دقائق)';
    }
    const days = Math.max(1, intervalDays);
    const nextAt = lastUploadAt + days * 86_400_000;
    if (nextAt <= Date.now()) {
      return 'مستحقة الآن — تُرفع عند توفر الإنترنت';
    }
    return formatDateTime(msToLocalString(nextAt));
  }, [autoEnabled, lastUploadAt, intervalDays]);

  return (
    <View style={styles.screen}>
      <AppHeader
        title="النسخ السحابي — Google Drive"
        subtitle={
          connected
            ? email.length > 0
              ? `مرتبط — ${email}`
              : 'مرتبط بحساب جوجل درايف'
            : 'ارفع نسخاً احتياطية تلقائية إلى حسابك واسترجعها متى شئت'
        }
        showBack
      />
      <ScrollView
        style={{flex: 1}}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled">
        {/* ── 1. الحالة والربط ── */}
        <Card style={styles.group}>
          {connected ? (
            <View style={styles.statusRow}>
              <View style={[styles.statusIcon, {backgroundColor: c.successSoft}]}>
                <Icon name="cloud" size={24} color={c.success} />
              </View>
              <View style={{flex: 1}}>
                <Text style={styles.statusTitle}>
                  مرتبط بحساب Google Drive
                </Text>
                <Text style={styles.statusSub}>
                  {email.length > 0 ? email : 'حساب جوجل'} · مجلد «{DRIVE_FOLDER_NAME}»
                </Text>
              </View>
              <AppButton
                title="فصل"
                variant="ghost"
                small
                onPress={disconnect}
              />
            </View>
          ) : (
            <>
              <SectionTitle
                title="ربط حساب Google Drive"
                hint="لمرة واحدة فقط — بعدها تعمل النسخ تلقائياً"
              />
              <View style={styles.guideBox}>
                <Text style={styles.guideIntro}>
                  الإعداد يتم من حسابك في Google Cloud Console (مجاني، ~3 دقائق):
                </Text>
                <GuideStep
                  n={1}
                  text="أنشئ مشروعاً جديداً في Google Cloud Console"
                  link="فتح Console"
                  url={SETUP_LINKS.project}
                />
                <GuideStep
                  n={2}
                  text="فعّل Google Drive API للمشروع"
                  link="تفعيل Drive API"
                  url={SETUP_LINKS.driveApi}
                />
                <GuideStep
                  n={3}
                  text="شاشة موافقة OAuth: External + Testing، وأضف بريدك في Test users"
                  link="فتح شاشة الموافقة"
                  url={SETUP_LINKS.consent}
                />
                <GuideStep
                  n={4}
                  text="أنشئ OAuth Client ID من نوع Desktop app وانسخ المعرّف والسر"
                  link="إنشاء OAuth Client"
                  url={SETUP_LINKS.credentials}
                />
              </View>
              <View style={{marginTop: spacing.md, gap: spacing.sm}}>
                <TextInput
                  style={styles.guideInput}
                  value={clientId}
                  onChangeText={setClientId}
                  placeholder="Client ID — ينتهي بـ apps.googleusercontent.com"
                  placeholderTextColor={c.textFaint}
                  autoCorrect={false}
                  autoCapitalize="none"
                  textAlign="left"
                />
                <TextInput
                  style={styles.guideInput}
                  value={clientSecret}
                  onChangeText={setClientSecret}
                  placeholder="Client Secret — GOCSPX-…"
                  placeholderTextColor={c.textFaint}
                  autoCorrect={false}
                  autoCapitalize="none"
                  textAlign="left"
                />
              </View>
              <AppButton
                title="ربط حساب جوجل الآن"
                icon="cloud"
                loading={connecting}
                onPress={() => void connect()}
                style={{marginTop: spacing.md}}
              />
              <Text style={styles.guideHint}>
                سيُفتح المتصفح لتسجيل الدخول والسماح بالوصول — التطبيق يرى فقط
                ملفات النسخ التي أنشأها بنفسه (نطاق drive.file).
              </Text>
            </>
          )}
        </Card>

        {connected ? (
          <>
            {/* ── 2. النسخ التلقائي ── */}
            <Card style={styles.group}>
              <SectionTitle
                title="الرفع التلقائي"
                hint="يُفحص الأمر عند فتح التطبيق وكل ربع ساعة"
              />
              <SwitchRow
                label="تفعيل الرفع التلقائي إلى درايف"
                hint="نسخة كاملة كل فترة محددة، ترفع متى توفر الإنترنت"
                value={autoEnabled}
                onValueChange={toggleAuto}
                icon="cloudUp"
              />
              <View style={{marginTop: spacing.md, gap: spacing.xs}}>
                <Text style={styles.paramLabel}>فترة الرفع (بالأيام)</Text>
                <Segmented
                  value={intervalDays}
                  onChange={changeInterval}
                  options={INTERVAL_OPTIONS}
                  compact
                />
              </View>
              <View style={styles.paramRow}>
                <Text style={styles.paramLabel}>آخر رفع</Text>
                <Text style={styles.paramValue}>
                  {lastUploadAt > 0
                    ? relativeTime(msToLocalString(lastUploadAt))
                    : 'لم تُرفع نسخة بعد'}
                </Text>
              </View>
              {nextDue ? (
                <View style={styles.paramRow}>
                  <Text style={styles.paramLabel}>الرفع القادم</Text>
                  <Text style={styles.paramValue}>{nextDue}</Text>
                </View>
              ) : null}
            </Card>

            {/* ── 3. رفع يدوي ── */}
            <Card style={styles.group}>
              <SectionTitle
                title="رفع نسخة الآن"
                hint="نسخة كاملة فورية إلى مجلد النسخ في درايف"
              />
              <AppButton
                title="رفع نسخة احتياطية الآن"
                icon="cloudUp"
                loading={uploading}
                onPress={() => void uploadNow()}
              />
            </Card>

            {/* ── 4. النسخ المرفوعة على الدرايف ── */}
            <Card style={styles.group}>
              <SectionTitle
                title={`النسخ المرفوعة على درايف${backups ? ` (${backups.length})` : ''}`}
                hint="استرجع آخر نسخة أو اختر أي نسخة بعينها"
                action={
                  <TouchableOpacity
                    style={styles.refreshBtn}
                    onPress={() => void refreshList(false)}
                    disabled={listing}
                    activeOpacity={0.7}>
                    {listing ? (
                      <ActivityIndicator size="small" color={c.accent} />
                    ) : (
                      <Icon name="refresh" size={16} color={c.accent} />
                    )}
                  </TouchableOpacity>
                }
              />
              {backups != null && backups.length > 0 ? (
                <>
                  <AppButton
                    title="استرجاع آخر نسخة مرفوعة"
                    icon="cloudDown"
                    variant="secondary"
                    small
                    loading={restoringId === backups[0].id}
                    onPress={() => restoreFrom(backups[0])}
                    style={{marginBottom: spacing.sm}}
                  />
                  {backups.map((file, index) => (
                    <View
                      key={file.id}
                      style={[
                        styles.backupRow,
                        index === 0 ? styles.backupRowFirst : null,
                      ]}>
                      <View style={[styles.backupIcon, {backgroundColor: c.accentSoft}]}>
                        <Icon name="save" size={18} color={c.accent} />
                      </View>
                      <View style={{flex: 1}}>
                        <View style={styles.backupNameRow}>
                          <Text style={styles.backupName} numberOfLines={1}>
                            {file.name}
                          </Text>
                          {index === 0 ? <Badge label="الأحدث" tone="success" /> : null}
                        </View>
                        <Text style={styles.backupMeta}>
                          {formatDateTime(msToLocalString(file.createdAtMs))} ·{' '}
                          {formatSize(file.sizeBytes)}
                        </Text>
                      </View>
                      <TouchableOpacity
                        style={styles.restoreBtn}
                        onPress={() => restoreFrom(file)}
                        disabled={restoringId != null || deletingId != null}
                        activeOpacity={0.7}>
                        {restoringId === file.id ? (
                          <ActivityIndicator size="small" color={c.success} />
                        ) : (
                          <Icon name="cloudDown" size={18} color={c.success} />
                        )}
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.deleteBtn}
                        onPress={() => deleteFrom(file)}
                        disabled={restoringId != null || deletingId != null}
                        activeOpacity={0.7}>
                        {deletingId === file.id ? (
                          <ActivityIndicator size="small" color={c.danger} />
                        ) : (
                          <Icon name="trash" size={17} color={c.danger} />
                        )}
                      </TouchableOpacity>
                    </View>
                  ))}
                </>
              ) : listing ? (
                <View style={styles.centerBox}>
                  <ActivityIndicator size="large" color={c.accent} />
                </View>
              ) : (
                <EmptyState
                  icon="cloud"
                  title="لا نسخ على درايف بعد"
                  subtitle="ارفع أول نسخة بزر «رفع نسخة احتياطية الآن» أو فعّل الرفع التلقائي"
                />
              )}
            </Card>

            {/* ── 5. سجل الرفع المحلي ── */}
            {history.length > 0 ? (
              <Card style={styles.group}>
                <SectionTitle
                  title="سجل الرفع"
                  hint="آخر العمليات على هذا الجهاز (نجاح وفشل)"
                />
                <TouchableOpacity
                  style={styles.historyToggle}
                  onPress={() => setHistoryOpen(!historyOpen)}
                  activeOpacity={0.7}>
                  <Icon
                    name={historyOpen ? 'chevronDown' : 'chevronLeft'}
                    size={13}
                    color={c.textFaint}
                  />
                  <Text style={styles.historyToggleText}>
                    {historyOpen ? 'إخفاء' : 'إظهار'} آخر {history.length} عملية
                  </Text>
                </TouchableOpacity>
                {historyOpen
                  ? history.map((entry, index) => (
                      <View key={`${entry.at}-${index}`} style={styles.historyRow}>
                        <View
                          style={[
                            styles.historyDot,
                            {
                              backgroundColor: entry.ok
                                ? c.success
                                : c.danger,
                            },
                          ]}
                        />
                        <View style={{flex: 1}}>
                          <Text style={styles.historyText} numberOfLines={1}>
                            {entry.ok
                              ? entry.name ?? 'نسخة مرفوعة'
                              : entry.error ?? 'فشل الرفع'}
                          </Text>
                          <Text style={styles.historyMeta}>
                            {relativeTime(msToLocalString(entry.at))} ·{' '}
                            {entry.reason === 'auto' ? 'تلقائي' : 'يدوي'}
                            {entry.ok && entry.sizeBytes
                              ? ` · ${formatSize(entry.sizeBytes)}`
                              : ''}
                          </Text>
                        </View>
                      </View>
                    ))
                  : null}
              </Card>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

/** One numbered setup step with an optional external link. */
function GuideStep({
  n,
  text,
  link,
  url,
}: {
  n: number;
  text: string;
  link: string;
  url: string;
}) {
  const c = useThemeColors();
  const styles = useStyles();
  return (
    <View style={styles.stepRow}>
      <View style={styles.stepBadge}>
        <Text style={styles.stepBadgeText}>{n}</Text>
      </View>
      <View style={{flex: 1}}>
        <Text style={styles.stepText}>{text}</Text>
        <TouchableOpacity
          onPress={() => {
            void Linking.openURL(url);
          }}
          activeOpacity={0.7}>
          <Text style={styles.stepLink}>{link} ↗</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const useStyles = makeStyles(c =>
  StyleSheet.create({
    screen: {flex: 1, backgroundColor: c.bg},
    content: {
      padding: spacing.lg,
      gap: spacing.md,
      paddingBottom: spacing.xxl,
    },
    group: {gap: spacing.sm},
    // ── Connection status ──
    statusRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
    },
    statusIcon: {
      width: 48,
      height: 48,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
    },
    statusTitle: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.body,
    },
    statusSub: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      marginTop: 2,
    },
    // ── Setup guide ──
    guideBox: {
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.borderSoft,
      padding: spacing.md,
      gap: spacing.md,
    },
    guideIntro: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.small,
      lineHeight: 20,
    },
    guideInput: {
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      paddingHorizontal: spacing.md,
      paddingVertical: 10,
      color: c.text,
      fontFamily: fonts.regular,
      fontSize: typography.small,
    },
    guideHint: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      lineHeight: 18,
      textAlign: 'center',
      marginTop: spacing.xs,
    },
    stepRow: {
      flexDirection: 'row',
      gap: spacing.sm,
      alignItems: 'flex-start',
    },
    stepBadge: {
      width: 24,
      height: 24,
      borderRadius: 8,
      backgroundColor: c.accentSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    stepBadgeText: {
      color: c.accent,
      fontFamily: fonts.bold,
      fontSize: typography.micro + 1,
    },
    stepText: {
      color: c.text,
      fontFamily: fonts.regular,
      fontSize: typography.small,
      lineHeight: 19,
      flex: 1,
    },
    stepLink: {
      color: c.accent,
      fontFamily: fonts.bold,
      fontSize: typography.micro + 1,
      marginTop: 2,
    },
    // ── Auto params ──
    paramLabel: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.small,
    },
    paramValue: {
      color: c.text,
      fontFamily: fonts.regular,
      fontSize: typography.small,
    },
    paramRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: 4,
    },
    // ── Backups list ──
    refreshBtn: {
      width: 34,
      height: 34,
      borderRadius: 10,
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    backupRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.borderSoft,
      padding: spacing.md,
      marginBottom: spacing.sm,
    },
    backupRowFirst: {borderColor: c.success},
    backupIcon: {
      width: 40,
      height: 40,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
    },
    backupNameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    backupName: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.small,
      flexShrink: 1,
    },
    backupMeta: {
      color: c.textDim,
      fontFamily: fonts.regular,
      fontSize: typography.micro + 1,
      marginTop: 2,
      fontVariant: ['tabular-nums'],
    },
    restoreBtn: {
      width: 38,
      height: 38,
      borderRadius: 11,
      backgroundColor: c.successSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    deleteBtn: {
      width: 38,
      height: 38,
      borderRadius: 11,
      backgroundColor: c.dangerSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    centerBox: {paddingVertical: spacing.xl, alignItems: 'center'},
    // ── History ──
    historyToggle: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingVertical: 4,
    },
    historyToggleText: {
      color: c.textDim,
      fontFamily: fonts.bold,
      fontSize: typography.micro + 1,
    },
    historyRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingVertical: 6,
    },
    historyDot: {width: 8, height: 8, borderRadius: 4},
    historyText: {
      color: c.text,
      fontFamily: fonts.bold,
      fontSize: typography.micro + 1,
    },
    historyMeta: {
      color: c.textFaint,
      fontFamily: fonts.regular,
      fontSize: typography.micro,
      marginTop: 1,
    },
  }),
);
