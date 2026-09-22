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

export default async function CompanyPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requirePermission("company.read");
  const { id } = await params;
  const [company, timeline, defs, settings] = await Promise.all([getCompany(id), getCompanyTimeline(id), listCustomFieldDefs("company"), getAppSettings()]);
  if (!company) notFound();
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
              <TabsTrigger value="opportunities">Opportunities</TabsTrigger>
              <TabsTrigger value="proposals">Proposals</TabsTrigger>
              <TabsTrigger value="contracts">Contracts</TabsTrigger>
              <TabsTrigger value="invoices">Invoices</TabsTrigger>
              <TabsTrigger value="devices">Devices</TabsTrigger>
              <TabsTrigger value="tasks">Tasks</TabsTrigger>
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

            {(["opportunities", "proposals", "contracts", "invoices", "devices", "tasks"] as const).map((tab) => (
              <TabsContent key={tab} value={tab}>
                <EmptyState title={`${tab[0].toUpperCase()}${tab.slice(1)} arrive in a later phase`} description={PHASE_NOTES[tab]} />
              </TabsContent>
            ))}
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

const PHASE_NOTES: Record<string, string> = {
  opportunities: "Phase 2 adds the sales pipeline.",
  proposals: "Phase 3 links Better Proposals.",
  contracts: "Phase 2 adds contracts and the service catalogue.",
  invoices: "Phase 4 connects Xero.",
  devices: "Phase 5 imports NinjaOne devices.",
  tasks: "Phase 2 adds tasks and onboarding.",
};
