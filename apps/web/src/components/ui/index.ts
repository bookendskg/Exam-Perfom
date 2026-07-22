/**
 * The design system's public surface.
 *
 * Screens import from here and nowhere deeper, so a primitive can be split or
 * rewritten without touching a single page. Replaces the former single
 * `components/ui.tsx`; the exported names are a superset of it, so existing
 * imports keep resolving.
 */

export { Button, buttonClasses } from './Button'
export type { ButtonVariant, ButtonSize } from './Button'

export { Field, Input, Textarea, Select } from './Field'
export type { SelectOption } from './Field'

export { Alert, Badge, Spinner, Skeleton, TableSkeleton, EmptyState } from './Feedback'
export type { Tone } from './Feedback'

export { Card, CardHeader, CardBody, PageHeader, Stat } from './Layout'

export { Table, Row, Cell, Pagination } from './DataTable'
export type { Column } from './DataTable'

export { Async } from './Async'
