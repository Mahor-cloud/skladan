import { MigrationStep } from './types'
import { m001CreateDefaultCompany } from './001-create-default-company'
import { m002MarkExistingAdmin } from './002-mark-existing-admin'
import { m003AddCompanyToCollections } from './003-add-company-to-collections'
import { m004AddIsSystemToRoles } from './004-add-isSystem-to-roles'
import { m005AddTotalAmountOrders } from './005-add-totalAmount-orders'
import { m006AddTotalAmountPurchases } from './006-add-totalAmount-purchases'
import { m007DropOldIndexes } from './007-drop-old-indexes'
import { m008CreateCompoundIndexes } from './008-create-compound-indexes'
import { m009InitCounters } from './009-init-counters'
import { m010CleanupDeadSubscriptions } from './010-cleanup-dead-subscriptions'
import { m011AddPerfIndexes } from './011-add-perf-indexes'

export const MIGRATIONS_V2_0_0: MigrationStep[] = [
	m001CreateDefaultCompany,
	m002MarkExistingAdmin,
	m003AddCompanyToCollections,
	m004AddIsSystemToRoles,
	m005AddTotalAmountOrders,
	m006AddTotalAmountPurchases,
	m007DropOldIndexes,
	m008CreateCompoundIndexes,
	m009InitCounters,
	m010CleanupDeadSubscriptions,
	m011AddPerfIndexes,
]

export const MIGRATION_VERSION = 'v2.0.0'
