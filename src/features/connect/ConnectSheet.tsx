import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  ButtonBase,
  Chip,
  CircularProgress,
  Divider,
  List,
  ListItem,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
  useTheme,
} from '@mui/material'
import { ArrowRight, CheckCircle2, Sparkles, Upload } from 'lucide-react'
import { shape } from '../../design/theme'
import { formatLocale } from '../../i18n/locales'
import { useLocale } from '../../state/hooks'
import type { Proposal } from '../v1/api'
import { SalesImportSheet } from '../v1/ImportMenu'
import type { SalesImport } from '../v1/useImport'
import { Sheet } from '../v1/Sheet'
import { useWorkspace } from '../v1/workspaceContext'
import { extraConnectCopy, useConnectCopy } from './strings'
import { useConnectUiCopy } from './uiStrings'
import type {
  ConnectorDiff,
  ConnectorMapping,
  ConnectorResult,
  FieldMapping,
  SavedMappingSummary,
} from './types'

const KNOWN_SYSTEMS = [
  { key: 'petpooja', label: 'Petpooja' },
  { key: 'tally', label: 'Tally' },
  { key: 'zoho', label: 'Zoho' },
  { key: 'square', label: 'Square' },
  { key: 'shopify', label: 'Shopify' },
  { key: 'sap', label: 'SAP' },
  { key: 'other', label: 'Other POS' },
] as const

const TARGET_ROLE_KEYS = [
  'name',
  'price',
  'unit',
  'stock',
  'category',
  'quantity',
  'total',
  'date',
  'none',
] as const

const ACCEPT_FILES =
  '.csv,.xlsx,.json,.xml,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/json,application/xml,text/xml'

export function ConnectSheet({
  open,
  onClose,
  initialSystem,
}: {
  open: boolean
  onClose: () => void
  initialSystem?: string
}) {
  const t = useConnectCopy()
  const ui = useConnectUiCopy()
  const locale = useLocale()
  const extra = extraConnectCopy[locale]
  const ws = useWorkspace()
  const roles = useTheme().material
  const shop = ws.active
  const systems = KNOWN_SYSTEMS.map((system) => ({
    ...system,
    displayLabel: system.key === 'other' ? ui.otherPos : system.label,
  }))

  const [selectedSystem, setSelectedSystem] = useState<string>(initialSystem ?? 'Petpooja')
  const [tab, setTab] = useState<'upload' | 'paste'>('upload')
  const [pastedText, setPastedText] = useState('')
  const [uploadedFile, setUploadedFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [error, setError] = useState('')
  const [savedMappings, setSavedMappings] = useState<SavedMappingSummary[]>([])
  const [salesImport, setSalesImport] = useState<SalesImport | null>(null)

  // Analysis result state
  const [analysis, setAnalysis] = useState<ConnectorResult | null>(null)
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [currentMapping, setCurrentMapping] = useState<ConnectorMapping | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)

  // Load saved mappings for this shop
  useEffect(() => {
    if (!open || !shop) return
    let active = true
    ws.api<SavedMappingSummary[]>(`/businesses/${encodeURIComponent(shop.id)}/connect/mappings`)
      .then((items) => {
        if (active) setSavedMappings(items)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [open, shop, ws])

  function handleClose() {
    setAnalysis(null)
    setCurrentMapping(null)
    setError('')
    setBusy(false)
    setAnalyzing(false)
    setPastedText('')
    setUploadedFile(null)
    setEditingIndex(null)
    onClose()
  }

  if (!shop) return null

  const savedForSelected = savedMappings.find(
    (m) => m.source_label.toLowerCase() === selectedSystem.toLowerCase(),
  )

  async function handleFileSelected(file: File) {
    if (!shop) return
    setError('')
    setAnalyzing(true)
    setUploadedFile(file)
    try {
      const result = await ws.api<ConnectorResult>(
        `/businesses/${encodeURIComponent(shop.id)}/connect/analyze?source_label=${encodeURIComponent(selectedSystem)}`,
        {
          method: 'POST',
          body: file,
          headers: { 'Content-Type': file.type || 'text/csv' },
        },
      )
      setAnalysis(result)
      setCurrentMapping(result.mapping)
    } catch {
      setError(ui.analyzeFileFailed)
    } finally {
      setAnalyzing(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function handleAnalyzePasted() {
    if (!shop || !pastedText.trim()) return
    setError('')
    setAnalyzing(true)
    try {
      const isJson = pastedText.trim().startsWith('{') || pastedText.trim().startsWith('[')
      const isXml = pastedText.trim().startsWith('<')
      const mime = isJson ? 'application/json' : isXml ? 'application/xml' : 'text/csv'

      const result = await ws.api<ConnectorResult>(
        `/businesses/${encodeURIComponent(shop.id)}/connect/analyze?source_label=${encodeURIComponent(selectedSystem)}`,
        {
          method: 'POST',
          body: JSON.stringify({
            content: pastedText,
            content_type: mime,
            source_label: selectedSystem,
          }),
          headers: { 'Content-Type': 'application/json' },
        },
      )
      setAnalysis(result)
      setCurrentMapping(result.mapping)
    } catch {
      setError(ui.analyzeSampleFailed)
    } finally {
      setAnalyzing(false)
    }
  }

  function handleFieldChange(index: number, newTarget: string) {
    if (!currentMapping) return
    if (
      newTarget !== 'none' &&
      currentMapping.fields.some(
        (field, fieldIndex) => fieldIndex !== index && field.target_field === newTarget,
      )
    )
      return
    const updatedFields = [...currentMapping.fields]
    const target = updatedFields[index]
    if (!target) return
    if (newTarget === 'none') {
      updatedFields.splice(index, 1)
    } else {
      updatedFields[index] = {
        ...target,
        target_field: newTarget,
        confidence: 1.0,
      }
    }
    setCurrentMapping({
      ...currentMapping,
      fields: updatedFields,
    })
    setEditingIndex(null)
  }

  async function handleConfirmAndSync() {
    if (!shop || !currentMapping) return
    setBusy(true)
    setError('')
    try {
      // 1. Save confirmed mapping
      await ws.api(`/businesses/${encodeURIComponent(shop.id)}/connect/mapping`, {
        method: 'POST',
        body: JSON.stringify({
          ...currentMapping,
          confirmed: true,
        }),
        headers: { 'Content-Type': 'application/json' },
      })

      // 2. Perform sync with the current mapping and payload
      let syncResult: {
        kind: 'menu' | 'sales'
        status: string
        proposal?: Proposal
        import_id?: string
        digest?: string
        diff?: ConnectorDiff
        summary?: SalesImport['summary']
        currency?: string
        sales?: SalesImport['sales']
      }

      if (tab === 'paste' && pastedText.trim()) {
        const isJson = pastedText.trim().startsWith('{') || pastedText.trim().startsWith('[')
        const isXml = pastedText.trim().startsWith('<')
        const mime = isJson ? 'application/json' : isXml ? 'application/xml' : 'text/csv'
        syncResult = await ws.api(
          `/businesses/${encodeURIComponent(shop.id)}/connect/sync?source_label=${encodeURIComponent(selectedSystem)}`,
          {
            method: 'POST',
            body: JSON.stringify({
              content: pastedText,
              content_type: mime,
              source_label: selectedSystem,
              mapping: currentMapping,
            }),
            headers: { 'Content-Type': 'application/json' },
          },
        )
      } else if (uploadedFile) {
        syncResult = await ws.api(
          `/businesses/${encodeURIComponent(shop.id)}/connect/sync?source_label=${encodeURIComponent(selectedSystem)}`,
          {
            method: 'POST',
            body: uploadedFile,
            headers: {
              'Content-Type': uploadedFile.type || 'text/csv',
              'x-source-label': selectedSystem,
            },
          },
        )
      } else {
        throw new Error(ui.noData)
      }

      // Close connect sheet and open proposal review before saving
      handleClose()
      if (syncResult.kind === 'menu' && syncResult.proposal) {
        ws.review(syncResult.proposal)
      } else if (
        syncResult.kind === 'sales' &&
        syncResult.import_id &&
        syncResult.digest &&
        syncResult.summary &&
        syncResult.currency &&
        syncResult.sales
      ) {
        setSalesImport({
          kind: 'sales',
          import_id: syncResult.import_id,
          digest: syncResult.digest,
          summary: syncResult.summary,
          currency: syncResult.currency,
          sales: syncResult.sales,
        })
      } else {
        ws.notify(t.mappingSaved)
      }
    } catch {
      setError(ui.syncFailed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Sheet
        open={open}
        onClose={handleClose}
        titleId="connect-sheet-title"
        title={t.connectTitle}
        // Without a mapping the only action is Close, so the phone sheet adds no second one.
        dismissInActions={!currentMapping}
        actions={
          currentMapping ? (
            <Stack direction="row" spacing={1.5} sx={{ justifyContent: 'flex-end' }}>
              <Button
                variant="outlined"
                disabled={busy}
                onClick={() => {
                  setAnalysis(null)
                  setCurrentMapping(null)
                }}
              >
                {t.editMapping}
              </Button>
              <Button
                variant="contained"
                disabled={busy}
                startIcon={busy ? <CircularProgress size={18} /> : <CheckCircle2 size={18} />}
                onClick={() => void handleConfirmAndSync()}
              >
                {analysis?.reused ? t.syncAndReview : t.confirmAndReview}
              </Button>
            </Stack>
          ) : (
            <Button onClick={handleClose}>{ui.close}</Button>
          )
        }
      >
        <Box sx={{ width: '100%', minWidth: 0, pt: 1 }}>
          <Typography variant="bodyMedium" color="text.secondary" sx={{ mb: 3 }}>
            {t.connectSubtitle}
          </Typography>

          {error && (
            <Alert severity="error" sx={{ mb: 3 }}>
              {error}
            </Alert>
          )}

          {!currentMapping ? (
            <Stack spacing={3}>
              {/* 1. Pick your system */}
              <Box>
                <Typography variant="titleSmall" sx={{ mb: 1.5, display: 'block' }}>
                  {t.pickSystem}
                </Typography>
                <Stack direction="row" sx={{ gap: 1, flexWrap: 'wrap' }}>
                  {[
                    ...systems,
                    { key: 'export', label: extra.uploadExport, displayLabel: extra.uploadExport },
                  ].map((sys) => {
                    const isSelected = selectedSystem === sys.label
                    const hasSaved = savedMappings.some(
                      (m) => m.source_label.toLowerCase() === sys.label.toLowerCase(),
                    )
                    return (
                      <ButtonBase
                        key={sys.key}
                        aria-pressed={isSelected}
                        onClick={() => setSelectedSystem(sys.label)}
                        sx={{
                          px: 2,
                          py: 1,
                          borderRadius: `${shape.sm}px`,
                          border: '1px solid',
                          borderColor: isSelected ? roles.primary : roles.outlineVariant,
                          bgcolor: isSelected
                            ? roles.primaryContainer
                            : roles.surfaceContainerHighest,
                          color: isSelected ? roles.onPrimaryContainer : roles.onSurface,
                          fontWeight: isSelected ? 600 : 400,
                          minHeight: 48,
                          minWidth: 48,
                          transition:
                            'border-color 0.15s ease-in-out, background-color 0.15s ease-in-out',
                          '&:hover': {
                            borderColor: roles.primary,
                          },
                        }}
                      >
                        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                          <span>{sys.displayLabel}</span>
                          {hasSaved && (
                            <Chip
                              size="small"
                              label={ui.connected}
                              sx={{
                                bgcolor: roles.primaryContainer,
                                color: roles.onPrimaryContainer,
                                height: 20,
                                fontSize: '0.7rem',
                                fontWeight: 600,
                              }}
                            />
                          )}
                        </Stack>
                      </ButtonBase>
                    )
                  })}
                </Stack>
                {savedForSelected?.last_synced && (
                  <Typography variant="bodySmall" color="text.secondary" sx={{ mt: 1.5 }}>
                    {t.lastSynced(
                      new Date(savedForSelected.last_synced * 1000).toLocaleString(
                        formatLocale(locale),
                      ),
                    )}
                  </Typography>
                )}
              </Box>

              <Divider />

              {/* 2. Upload or paste */}
              <Box>
                <Typography variant="titleSmall" sx={{ mb: 1.5, display: 'block' }}>
                  {t.uploadOrPaste}
                </Typography>

                <Tabs
                  variant="fullWidth"
                  value={tab}
                  onChange={(_, v) => setTab(v as 'upload' | 'paste')}
                  sx={{ mb: 2, minHeight: 48 }}
                >
                  <Tab
                    label={t.uploadFile}
                    value="upload"
                    sx={{ minHeight: 48, py: 0.5, whiteSpace: 'normal', overflowWrap: 'anywhere' }}
                  />
                  <Tab
                    label={t.pasteData}
                    value="paste"
                    sx={{ minHeight: 48, py: 0.5, whiteSpace: 'normal', overflowWrap: 'anywhere' }}
                  />
                </Tabs>

                {tab === 'upload' ? (
                  <Stack spacing={2} sx={{ alignItems: 'flex-start' }}>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept={ACCEPT_FILES}
                      hidden
                      aria-hidden="true"
                      tabIndex={-1}
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        if (file) void handleFileSelected(file)
                      }}
                    />
                    <Button
                      variant="outlined"
                      startIcon={analyzing ? <CircularProgress size={18} /> : <Upload size={18} />}
                      disabled={analyzing}
                      onClick={() => fileInputRef.current?.click()}
                      sx={{
                        minHeight: 48,
                        maxWidth: '100%',
                        height: 'auto',
                        py: 1,
                        textAlign: 'start',
                        whiteSpace: 'normal',
                        overflowWrap: 'anywhere',
                      }}
                    >
                      {analyzing ? t.analyzing : t.uploadFile}
                    </Button>
                    {error && uploadedFile && (
                      <Button
                        variant="text"
                        disabled={analyzing}
                        onClick={() => void handleFileSelected(uploadedFile)}
                        sx={{ minHeight: 48 }}
                      >
                        {extra.retry}
                      </Button>
                    )}
                    {analyzing && (
                      <Typography
                        role="status"
                        aria-live="polite"
                        variant="bodySmall"
                        color="text.secondary"
                      >
                        {t.analyzing}
                      </Typography>
                    )}
                  </Stack>
                ) : (
                  <Stack spacing={2}>
                    <TextField
                      multiline
                      minRows={4}
                      maxRows={8}
                      value={pastedText}
                      onChange={(e) => setPastedText(e.target.value)}
                      placeholder={t.pastePlaceholder}
                      aria-label={t.pasteData}
                      fullWidth
                    />
                    <Button
                      variant="contained"
                      disabled={!pastedText.trim() || analyzing}
                      startIcon={
                        analyzing ? <CircularProgress size={18} /> : <Sparkles size={18} />
                      }
                      onClick={() => void handleAnalyzePasted()}
                      sx={{ alignSelf: 'flex-start', minHeight: 48 }}
                    >
                      {analyzing ? t.analyzing : 'Analyze sample'}
                    </Button>
                    {error && pastedText.trim() && (
                      <Button
                        variant="text"
                        disabled={analyzing}
                        onClick={() => void handleAnalyzePasted()}
                        sx={{ alignSelf: 'flex-start', minHeight: 48 }}
                      >
                        {extra.retry}
                      </Button>
                    )}
                  </Stack>
                )}
              </Box>
            </Stack>
          ) : (
            /* Step 2: AI Mapping & Review */
            <Stack spacing={3}>
              {analysis?.reused && (
                <Alert severity="success" icon={<CheckCircle2 size={20} />}>
                  {t.reusedMapping} ({currentMapping.source_label})
                </Alert>
              )}

              <Box>
                <Typography variant="titleMedium">{t.mappingTitle}</Typography>
                <Typography variant="bodySmall" color="text.secondary" sx={{ mb: 2 }}>
                  {t.mappingSubtitle}
                </Typography>

                {/* Mapped Fields List */}
                <List disablePadding sx={{ borderRadius: `${shape.sm}px`, overflow: 'hidden' }}>
                  {currentMapping.fields.map((f: FieldMapping, idx: number) => {
                    const roleLabel =
                      t.targetRoles[f.target_field as keyof typeof t.targetRoles] ?? f.target_field
                    const confidencePct = Math.round(f.confidence * 100)
                    const isEditing = editingIndex === idx

                    return (
                      <ListItem
                        key={f.source_field}
                        disableGutters
                        divider
                        sx={{
                          py: 1.5,
                          px: 1,
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'stretch',
                        }}
                      >
                        <Stack
                          direction="row"
                          sx={{
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 1,
                            flexWrap: 'wrap',
                          }}
                        >
                          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                            <Chip
                              label={f.source_field}
                              size="small"
                              variant="outlined"
                              sx={{ fontFamily: 'monospace', fontWeight: 600 }}
                            />
                            <ArrowRight size={16} />
                            <Chip
                              label={roleLabel}
                              size="small"
                              color="primary"
                              onClick={() => setEditingIndex(isEditing ? null : idx)}
                              sx={{ fontWeight: 600, cursor: 'pointer' }}
                            />
                          </Stack>

                          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                            <Typography variant="bodySmall" color="text.secondary">
                              {confidencePct}%
                            </Typography>
                            <Button
                              size="small"
                              onClick={() => setEditingIndex(isEditing ? null : idx)}
                            >
                              {isEditing ? 'Done' : t.changeField}
                            </Button>
                          </Stack>
                        </Stack>

                        {/* Sample values */}
                        {f.sample_values && f.sample_values.length > 0 && (
                          <Typography
                            variant="bodySmall"
                            color="text.secondary"
                            sx={{ mt: 0.5, fontStyle: 'italic' }}
                          >
                            {t.sampleValues}: {f.sample_values.join(', ')}
                          </Typography>
                        )}

                        {/* One-tap field change picker */}
                        {isEditing && (
                          <Box
                            sx={{ mt: 1.5, pt: 1, borderTop: `1px dashed ${roles.outlineVariant}` }}
                          >
                            <Typography
                              variant="labelSmall"
                              color="text.secondary"
                              sx={{ mb: 1, display: 'block' }}
                            >
                              Select Chalkboard role for &quot;{f.source_field}&quot;:
                            </Typography>
                            <Stack direction="row" sx={{ gap: 0.75, flexWrap: 'wrap' }}>
                              {TARGET_ROLE_KEYS.filter(
                                (rk) =>
                                  rk === f.target_field ||
                                  !currentMapping.fields.some(
                                    (field, fieldIndex) =>
                                      fieldIndex !== idx && field.target_field === rk,
                                  ),
                              ).map((rk) => (
                                <Chip
                                  key={rk}
                                  label={t.targetRoles[rk]}
                                  size="small"
                                  clickable
                                  color={rk === f.target_field ? 'primary' : 'default'}
                                  variant={rk === f.target_field ? 'filled' : 'outlined'}
                                  onClick={() => handleFieldChange(idx, rk)}
                                  sx={{ minHeight: 48 }}
                                />
                              ))}
                            </Stack>
                          </Box>
                        )}
                      </ListItem>
                    )
                  })}
                </List>
              </Box>

              {/* Mapped preview rows */}
              {analysis && analysis.preview_rows.length > 0 && (
                <Box>
                  <Typography variant="titleSmall" sx={{ mb: 1 }}>
                    {t.previewTitle} ({analysis.total_rows} total rows)
                  </Typography>
                  <Stack spacing={1}>
                    {analysis.preview_rows.slice(0, 3).map((_, i) => (
                      <Box
                        key={i}
                        sx={{
                          p: 1.5,
                          borderRadius: `${shape.sm}px`,
                          bgcolor: roles.surfaceContainerHighest,
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: 1.5,
                        }}
                      >
                        {currentMapping.fields.flatMap((field) => {
                          const value = field.sample_values[i] ?? field.sample_values[0]
                          if (!value) return []
                          const role =
                            t.targetRoles[field.target_field as keyof typeof t.targetRoles]
                          return [
                            <Typography key={field.source_field} variant="bodySmall">
                              <strong>{role}:</strong> {value}
                            </Typography>,
                          ]
                        })}
                      </Box>
                    ))}
                  </Stack>
                </Box>
              )}

              {/* Diff Summary */}
              {analysis?.diff && (
                <Box>
                  <Typography variant="titleSmall" sx={{ mb: 1 }}>
                    {t.diffTitle}
                  </Typography>
                  <Stack direction="row" spacing={1}>
                    <Chip
                      size="small"
                      label={t.addedItems(analysis.diff.added.length)}
                      sx={{
                        bgcolor: roles.primaryContainer,
                        color: roles.onPrimaryContainer,
                        fontWeight: 600,
                      }}
                    />
                    <Chip
                      size="small"
                      label={t.updatedItems(analysis.diff.updated.length)}
                      sx={{
                        bgcolor: roles.secondaryContainer,
                        color: roles.onSecondaryContainer,
                        fontWeight: 600,
                      }}
                    />
                    {analysis.diff.removed.length > 0 && (
                      <Chip
                        size="small"
                        label={t.removedItems(analysis.diff.removed.length)}
                        sx={{
                          bgcolor: roles.errorContainer,
                          color: roles.onErrorContainer,
                          fontWeight: 600,
                        }}
                      />
                    )}
                  </Stack>
                </Box>
              )}
            </Stack>
          )}
        </Box>
      </Sheet>
      <SalesImportSheet
        imported={salesImport}
        onClose={() => setSalesImport(null)}
        showResultOnSave
        resultText={
          salesImport
            ? extra.salesImported(
                new Intl.NumberFormat(locale).format(salesImport.summary.rows),
                new Intl.NumberFormat(locale).format(salesImport.summary.items),
              )
            : undefined
        }
      />
    </>
  )
}
