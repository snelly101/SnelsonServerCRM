import Link from "next/link";
import { notFound } from "next/navigation";
import { Pencil, Archive, ArchiveRestore, Plus, Globe, Phone, Mail } from "lucide-react";
import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { getCompany, getCompanyTimeline } from "@/services/companies";
import { listCustomFieldDefs } from "@/services/settings";
import { getAppSettings } from "@/lib/settings";
import { archiveCompanyAction, archiveSiteAction } from "@/actions/companies";
import { archiveContactAction } from "@/actions/contacts";
import { PageHeader, Card, DescriptionList, EmptyState } from "@/components/ui/page";
import { ButtonLink } from "@/components/ui/button";
import { Badge, STATUS_TONES, ROLE_LABELS_CONTACT } from "@/components/ui/badge";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Alert } from "@/components/ui/alert";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { CustomFieldsDisplay } from "@/components/custom-fields";
import { SiteDialog } from "@/components/site-dialog";
import { NoteForm } from "@/components/note-form";
import { Timeline } from "@/components/timeline";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { fullName } from "@/lib/utils";
import { listCompanyOpportunities } from "@/services/opportunities";
import { listCompanyContracts } from "@/services/contracts";
import { listTasks } from "@/services/tasks";
import { listOnboardings } from "@/services/onboarding";
import { listOwners } from "@/services/companies";
import { TaskList } from "@/components/task-list";
import { TaskDialog } from "@/components/task-dialog";
import { RevenueSummaryBadges } from "@/components/lines-editor";
import { fmtMoney } from "@/lib/format";
import { listProposals } from "@/services/proposals";
import { ExternalLink } from "lucide-react";
import { companyFinancialSummary, xeroConnectionSummary } from "@/services/xero";
import { fmtRelative } from "@/lib/format";
import { companyDeviceOverview } from "@/services/ninjaone";
import { DeviceTable, FRESHNESS_LABEL, FRESHNESS_TONE } from "@/components/device-table";
import { DiscrepancyTable } from "@/app/(app)/devices/discrepancies";

export default async function CompanyPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requirePermission("company.read");
  const { id } = await params;
  const [company, timeline, defs, settings, opportunities, companyContracts, companyTasks, onboardingList, owners, proposalList, finance, xero, devices] = await Promise.all([
    getCompany(id),
    getCompanyTimeline(id),
    listCustomFieldDefs("company"),
    getAppSettings(),
    listCompanyOpportunities(id),
    listCompanyContracts(id),
    listTasks({ companyId: id, status: "all", pageSize: 100 }),
    listOnboardings(id),
    listOwners(),
    listProposals({ companyId: id, pageSize: 50 }),
    can(me.role, "finance.read") ? companyFinancialSummary(id) : Promise.resolve(null),
    xeroConnectionSummary(),
    can(me.role, "device.read") ? companyDeviceOverview(id) : Promise.resolve(null),
  ]);
  if (!company) notFound();
  const activeContracts = companyContracts.filter((c) => c.status === "active");
  const mrr = activeContracts.reduce((a, c) => a + c.summary.mrr, 0);
  const openOpps = opportunities.filter((o) => o.status === "open");
  const canWrite = can(me.role, "company.write");
  const address = [company.addressLine1, company.addressLine2, company.city, company.region, company.postcode, company.country].filter(Boolean).join(", ");

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Companies", href: "/companies" }, { label: company.name }]}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {company.name}
            <Badge tone={STATUS_TONES[company.status]}>{company.status}</Badge>
            {company.tags.map((t) => (
              <Badge key={t.id} tone={t.color}>
                {t.name}
              </Badge>
            ))}
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-3">
            {company.website && (
              <a href={company.website.startsWith("http") ? company.website : `https://${company.website}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-brand-700">
                <Globe className="h-3.5 w-3.5" /> {company.domain ?? company.website}
              </a>
            )}
            {company.phone && (
              <a href={`tel:${company.phone}`} className="inline-flex items-center gap-1 hover:text-brand-700">
                <Phone className="h-3.5 w-3.5" /> {company.phone}
              </a>
            )}
            {company.email && (
              <a href={`mailto:${company.email}`} className="inline-flex items-center gap-1 hover:text-brand-700">
                <Mail className="h-3.5 w-3.5" /> {company.email}
              </a>
            )}
          </span>
        }
        actions={
          canWrite && (
            <>
              <ButtonLink href={`/companies/${id}/edit`} variant="secondary">
                <Pencil className="h-4 w-4" /> Edit
              </ButtonLink>
              {can(me.role, "company.delete") &&
                (company.archivedAt ? (
                  <ConfirmButton variant="secondary" action={archiveCompanyAction.bind(null, id, true)} title="Restore this company?" confirmLabel="Restore">
                    <ArchiveRestore className="h-4 w-4" /> Restore
                  </ConfirmButton>
                ) : (
                  <ConfirmButton
                    variant="danger-outline"
                    action={archiveCompanyAction.bind(null, id, false)}
                    title="Archive this company?"
                    description="It will be hidden from lists but nothing is deleted. Linked contacts, opportunities and history are kept and you can restore it later."
                    confirmLabel="Archive"
                  >
                    <Archive className="h-4 w-4" /> Archive
                  </ConfirmButton>
                ))}
            </>
          )
        }
      />
      {company.archivedAt && (
        <Alert tone="warn" className="mb-4">
          This company was archived on {fmtDate(company.archivedAt, settings)}.
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Tabs defaultValue="overview">
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="contacts" count={company.contacts.length}>
                Contacts
              </TabsTrigger>
              <TabsTrigger value="sites" count={company.sites.length}>
                Sites
              </TabsTrigger>
              <TabsTrigger value="opportunities" count={openOpps.length}>
                Opportunities
              </TabsTrigger>
              <TabsTrigger value="proposals" count={proposalList.total}>
                Proposals
              </TabsTrigger>
              <TabsTrigger value="contracts" count={activeContracts.length}>
                Contracts
              </TabsTrigger>
              <TabsTrigger value="invoices" count={finance?.count}>
                Invoices
              </TabsTrigger>
              <TabsTrigger value="devices" count={devices?.totals.active}>
                Devices
              </TabsTrigger>
              <TabsTrigger value="tasks" count={companyTasks.rows.filter((t) => t.status === "open").length}>
                Tasks
              </TabsTrigger>
            </TabsList>

            <TabsContent value="overview">
              <Card title="Details">
                <DescriptionList
                  items={[
                    { label: "Account owner", value: company.ownerName ?? "Unassigned" },
                    { label: "Industry", value: company.industry },
                    { label: "Company number", value: company.companyNumber },
                    { label: "VAT number", value: company.vatNumber },
                    { label: "Billing address", value: address || null },
                    { label: "Created", value: fmtDate(company.createdAt, settings) },
                  ]}
                />
                {defs.length > 0 && (
                  <div className="mt-4 border-t border-slate-100 pt-4">
                    <CustomFieldsDisplay defs={defs} values={company.customFields} />
                  </div>
                )}
                {company.notes && (
                  <div className="mt-4 border-t border-slate-100 pt-4">
                    <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Internal notes</div>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-slate-800">{company.notes}</p>
                  </div>
                )}
              </Card>
            </TabsContent>

            <TabsContent value="contacts">
              <Card
                title="Contacts"
                padded={false}
                actions={
                  can(me.role, "contact.write") && (
                    <ButtonLink href={`/contacts/new?companyId=${id}`} size="sm">
                      <Plus className="h-4 w-4" /> Add contact
                    </ButtonLink>
                  )
                }
              >
                {company.contacts.length === 0 ? (
                  <div className="p-4">
                    <EmptyState title="No contacts yet" description="Add the decision maker, technical and billing contacts." />
                  </div>
                ) : (
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Roles</th>
                        <th>Email</th>
                        <th>Phone</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {company.contacts.map((c) => (
                        <tr key={c.id}>
                          <td>
                            <Link href={`/contacts/${c.id}`} className="font-medium text-brand-700 hover:underline">
                              {fullName(c)}
                            </Link>
                            {c.isPrimary && <Badge className="ml-1" tone="green">primary</Badge>}
                            {c.jobTitle && <div className="text-xs text-slate-500">{c.jobTitle}</div>}
                          </td>
                          <td>
                            <div className="flex flex-wrap gap-1">
                              {c.roles.map((r) => (
                                <Badge key={r}>{ROLE_LABELS_CONTACT[r]}</Badge>
                              ))}
                            </div>
                          </td>
                          <td>{c.email ? <a href={`mailto:${c.email}`} className="hover:underline">{c.email}</a> : "—"}</td>
                          <td>{c.mobile ?? c.phone ?? "—"}</td>
                          <td className="text-right">
                            {can(me.role, "contact.delete") && (
                              <ConfirmButton variant="ghost" size="sm" action={archiveContactAction.bind(null, c.id, id)} title={`Archive ${fullName(c)}?`} confirmLabel="Archive">
                                Archive
                              </ConfirmButton>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            </TabsContent>

            <TabsContent value="sites">
              <Card title="Sites" padded={false} actions={canWrite && <SiteDialog companyId={id} />}>
                {company.sites.length === 0 ? (
                  <div className="p-4">
                    <EmptyState title="No sites yet" description="Sites are physical locations. NinjaOne locations are mapped to sites in Phase 5." />
                  </div>
                ) : (
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Site</th>
                        <th>Address</th>
                        <th>Phone</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {company.sites.map((s) => (
                        <tr key={s.id}>
                          <td>
                            <span className="font-medium">{s.name}</span>
                            {s.isPrimary && <Badge className="ml-1" tone="green">primary</Badge>}
                          </td>
                          <td className="text-slate-600">{[s.addressLine1, s.city, s.postcode].filter(Boolean).join(", ") || "—"}</td>
                          <td>{s.phone ?? "—"}</td>
                          <td className="text-right">
                            {canWrite && (
                              <span className="inline-flex items-center gap-1">
                                <SiteDialog companyId={id} site={s} />
                                <ConfirmButton variant="ghost" size="sm" action={archiveSiteAction.bind(null, s.id, id)} title={`Archive site ${s.name}?`} confirmLabel="Archive">
                                  Archive
                                </ConfirmButton>
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            </TabsContent>

            <TabsContent value="opportunities">
              <Card
                title="Opportunities"
                padded={false}
                actions={
                  can(me.role, "opportunity.write") && (
                    <ButtonLink href={`/pipeline/new?companyId=${id}`} size="sm">
                      <Plus className="h-4 w-4" /> New opportunity
                    </ButtonLink>
                  )
                }
              >
                {opportunities.length === 0 ? (
                  <div className="p-4">
                    <EmptyState title="No opportunities yet" />
                  </div>
                ) : (
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Opportunity</th>
                        <th>Stage</th>
                        <th className="text-right">First-year value</th>
                        <th className="text-right">MRR</th>
                        <th>Expected close</th>
                        <th>Owner</th>
                      </tr>
                    </thead>
                    <tbody>
                      {opportunities.map((o) => (
                        <tr key={o.id}>
                          <td>
                            <Link href={`/pipeline/${o.id}`} className="font-medium text-brand-700 hover:underline">
                              {o.title}
                            </Link>
                          </td>
                          <td>
                            <Badge tone={o.status === "won" ? "green" : o.status === "lost" ? "red" : o.stageColor}>{o.status === "open" ? o.stageName : o.status}</Badge>
                          </td>
                          <td className="text-right tabular-nums">{fmtMoney(o.summary.firstYearValue, settings.currency)}</td>
                          <td className="text-right tabular-nums">{fmtMoney(o.summary.mrr, settings.currency)}</td>
                          <td>{fmtDate(o.expectedCloseDate, settings)}</td>
                          <td>{o.ownerName ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            </TabsContent>

            <TabsContent value="contracts">
              <Card
                title={`Contracts · MRR ${fmtMoney(mrr, settings.currency)}`}
                padded={false}
                actions={
                  can(me.role, "contract.write") && (
                    <ButtonLink href={`/contracts/new?companyId=${id}`} size="sm">
                      <Plus className="h-4 w-4" /> New contract
                    </ButtonLink>
                  )
                }
              >
                {companyContracts.length === 0 ? (
                  <div className="p-4">
                    <EmptyState title="No contracts yet" description="Contracts are drafted automatically when an opportunity is won, or created here." />
                  </div>
                ) : (
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Contract</th>
                        <th>Status</th>
                        <th>Value</th>
                        <th>Renewal</th>
                        <th>Next review</th>
                      </tr>
                    </thead>
                    <tbody>
                      {companyContracts.map((c) => (
                        <tr key={c.id}>
                          <td>
                            <Link href={`/contracts/${c.id}`} className="font-medium text-brand-700 hover:underline">
                              {c.name}
                            </Link>
                          </td>
                          <td>
                            <Badge tone={c.status === "active" ? "green" : c.status === "draft" ? "slate" : "amber"}>{c.status}</Badge>
                          </td>
                          <td>
                            <RevenueSummaryBadges summary={c.summary} currency={settings.currency} compact />
                          </td>
                          <td>{fmtDate(c.renewalDate, settings)}</td>
                          <td>{fmtDate(c.nextReviewDate, settings)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            </TabsContent>

            <TabsContent value="tasks">
              <Card title="Tasks" padded={false} actions={can(me.role, "task.write") && <TaskDialog owners={owners} defaults={{ companyId: id }} />}>
                <TaskList tasks={companyTasks.rows} canWrite={can(me.role, "task.write")} settings={settings} compact />
              </Card>
              {onboardingList.length > 0 && (
                <Card title="Onboarding" padded={false} className="mt-4">
                  <ul className="divide-y divide-slate-100">
                    {onboardingList.map((o) => (
                      <li key={o.id} className="flex items-center justify-between px-4 py-2 text-sm">
                        <Link href={`/tasks/onboarding/${o.id}`} className="font-medium text-brand-700 hover:underline">
                          {o.name}
                        </Link>
                        <span className="text-xs text-slate-500">
                          {o.done}/{o.total} · <Badge tone={o.status === "completed" ? "green" : "blue"}>{o.status.replace("_", " ")}</Badge>
                        </span>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
            </TabsContent>

            <TabsContent value="proposals">
              <Card title="Proposals" padded={false}>
                {proposalList.rows.length === 0 ? (
                  <div className="p-4">
                    <EmptyState title="No proposals" description="Create one from an opportunity, or link an existing Better Proposals document on the Proposals page." />
                  </div>
                ) : (
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Proposal</th>
                        <th>Status</th>
                        <th>Opportunity</th>
                        <th>Sent</th>
                        <th>Signed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {proposalList.rows.map((p) => (
                        <tr key={p.id}>
                          <td>
                            {p.subjectLine ?? `Proposal ${p.externalId}`}
                            {p.viewUrl && (
                              <a href={p.viewUrl} target="_blank" rel="noreferrer" className="ml-1 inline-flex align-middle text-slate-400 hover:text-brand-700" aria-label="Open in Better Proposals">
                                <ExternalLink className="h-3.5 w-3.5" />
                              </a>
                            )}
                          </td>
                          <td>
                            <Badge tone={p.status === "signed" || p.status === "paid" ? "green" : p.status === "opened" ? "indigo" : p.status === "sent" ? "blue" : "slate"}>{p.status}</Badge>
                          </td>
                          <td>{p.opportunityId ? <Link href={`/pipeline/${p.opportunityId}`} className="hover:underline">{p.opportunityTitle}</Link> : "—"}</td>
                          <td>{fmtDate(p.sentAt, settings)}</td>
                          <td>{fmtDate(p.signedAt, settings)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            </TabsContent>

            <TabsContent value="invoices">
              {!finance ? (
                <EmptyState title="Finance data is restricted" description="Only finance users and administrators can see invoices." />
              ) : (
                <div className="space-y-4">
                  <Card title="Financial summary" actions={xero.demo ? <Badge tone="amber">demo</Badge> : finance.link ? <Badge tone="green">linked to Xero</Badge> : <Badge tone="amber">not linked to Xero</Badge>}>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <div>
                        <div className="text-xs uppercase tracking-wide text-slate-500">Outstanding</div>
                        <div className="text-lg font-semibold">{fmtMoney(finance.xeroContact?.outstanding ?? finance.outstanding, settings.currency)}</div>
                        <div className="text-[11px] text-slate-500">{finance.xeroContact ? `Xero balance · fetched ${fmtRelative(finance.xeroContact.fetchedAt)}` : "from mirrored invoices"}</div>
                      </div>
                      <div>
                        <div className="text-xs uppercase tracking-wide text-slate-500">Overdue</div>
                        <div className={`text-lg font-semibold ${Number(finance.xeroContact?.overdue ?? finance.overdue) > 0 ? "text-red-700" : ""}`}>{fmtMoney(finance.xeroContact?.overdue ?? finance.overdue, settings.currency)}</div>
                      </div>
                      <div>
                        <div className="text-xs uppercase tracking-wide text-slate-500">Invoiced (12 months)</div>
                        <div className="text-lg font-semibold">{fmtMoney(finance.invoiced12m, settings.currency)}</div>
                      </div>
                      <div>
                        <div className="text-xs uppercase tracking-wide text-slate-500">Paid (12 months)</div>
                        <div className="text-lg font-semibold text-green-700">{fmtMoney(finance.paid12m, settings.currency)}</div>
                      </div>
                    </div>
                    {!finance.link && <p className="mt-3 text-xs text-amber-700">Link this company to its Xero contact on Integrations → Xero to see its invoices and create drafts.</p>}
                  </Card>
                  {finance.drafts.length > 0 && (
                    <Card title="Draft invoices awaiting approval" padded={false}>
                      <ul className="divide-y divide-slate-100 text-sm">
                        {finance.drafts.map((d) => (
                          <li key={d.id} className="flex items-center justify-between px-4 py-2">
                            <Link href={`/finance/drafts/${d.id}`} className="text-brand-700 hover:underline">
                              {d.reference} · {d.description ?? "draft"}
                            </Link>
                            <span className="text-xs text-slate-500">{fmtMoney(d.subTotal, d.currencyCode)} net · <Badge tone={d.status === "failed" ? "red" : "slate"}>{d.status}</Badge></span>
                          </li>
                        ))}
                      </ul>
                    </Card>
                  )}
                  <Card title="Invoices (from Xero)" padded={false}>
                    {finance.invoices.length === 0 ? (
                      <div className="p-4">
                        <EmptyState title="No invoices" description={finance.link ? "None mirrored yet; run a Xero sync." : "Link the company to a Xero contact first."} />
                      </div>
                    ) : (
                      <table className="tbl">
                        <thead>
                          <tr>
                            <th>Invoice</th>
                            <th>Status</th>
                            <th>Date</th>
                            <th>Due</th>
                            <th className="text-right">Total</th>
                            <th className="text-right">Amount due</th>
                          </tr>
                        </thead>
                        <tbody>
                          {finance.invoices.map((i) => {
                            const overdue = i.status === "AUTHORISED" && i.dueDate && i.dueDate < new Date().toISOString().slice(0, 10);
                            return (
                              <tr key={i.id}>
                                <td className="font-medium">{i.invoiceNumber ?? i.invoiceId.slice(0, 8)}{i.reference ? <span className="ml-1 text-xs font-normal text-slate-500">{i.reference}</span> : null}</td>
                                <td>
                                  <Badge tone={overdue ? "red" : i.status === "PAID" ? "green" : i.status === "AUTHORISED" ? "indigo" : "slate"}>{overdue ? "overdue" : i.status.toLowerCase()}</Badge>
                                </td>
                                <td>{fmtDate(i.date, settings)}</td>
                                <td className={overdue ? "text-red-600" : ""}>{fmtDate(i.dueDate, settings)}</td>
                                <td className="text-right tabular-nums">{fmtMoney(i.total, i.currencyCode ?? settings.currency)}</td>
                                <td className="text-right tabular-nums font-medium">{fmtMoney(i.amountDue, i.currencyCode ?? settings.currency)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                  </Card>
                </div>
              )}
            </TabsContent>

            <TabsContent value="devices">
              {!devices ? (
                <EmptyState title="Not linked to a NinjaOne organisation" description="Link this company on Integrations → NinjaOne to see its managed devices and compare them with the contract." action={can(me.role, "integration.manage") ? <ButtonLink href="/integrations/ninjaone" variant="secondary">Open NinjaOne mapping</ButtonLink> : undefined} />
              ) : (
                <div className="space-y-4">
                  <Card
                    title={`Devices · ${devices.org?.name ?? devices.link.externalName ?? "NinjaOne organisation"}`}
                    actions={
                      <span className="flex items-center gap-2">
                        {devices.mode === "demo" && <Badge tone="amber">demo</Badge>}
                        <Badge tone={FRESHNESS_TONE[devices.totals.freshness]}>{FRESHNESS_LABEL[devices.totals.freshness]}</Badge>
                        {devices.consoleUrl && (
                          <a href={devices.consoleUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-brand-700 hover:underline">
                            Open in NinjaOne <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </span>
                    }
                  >
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                      {[
                        ["Total", devices.totals.total],
                        [`Active (${devices.totals.activeDays}d)`, devices.totals.active],
                        ["Billable class", devices.totals.billable],
                        ["Servers", devices.totals.servers],
                        ["Needs attention", devices.totals.needsAttention],
                      ].map(([label, value]) => (
                        <div key={String(label)}>
                          <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
                          <div className="text-lg font-semibold">{value}</div>
                        </div>
                      ))}
                    </div>
                    <p className="mt-2 text-[11px] text-slate-500">{devices.totals.lastFetched ? `Fetched ${fmtRelative(new Date(devices.totals.lastFetched))}` : "Not fetched yet"} · read-only mirror of NinjaOne</p>
                  </Card>
                  {devices.discrepancies.length > 0 && (
                    <Card title="Contract vs observed" padded={false}>
                      <DiscrepancyTable rows={devices.discrepancies} canReview={can(me.role, "discrepancy.review")} currency={settings.currency} compact />
                    </Card>
                  )}
                  <Card padded={false}>
                    <DeviceTable rows={devices.devices} showCompany={false} />
                  </Card>
                </div>
              )}
            </TabsContent>
          </Tabs>
        </div>

        <div className="space-y-4">
          {canWrite && (
            <Card title="Log an activity">
              <NoteForm companyId={id} contacts={company.contacts.map((c) => ({ id: c.id, name: fullName(c) }))} />
            </Card>
          )}
          <Card title="Timeline" padded={false}>
            <Timeline items={timeline.map((t) => ({ ...t, at: fmtDateTime(t.at, settings) }))} />
          </Card>
        </div>
      </div>
    </>
  );
}
