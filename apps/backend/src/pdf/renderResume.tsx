import type { Profile, TailoredResume } from '@djobi/shared';
import { Document, Page, renderToBuffer, StyleSheet, Text, View } from '@react-pdf/renderer';
import React from 'react';

const styles = StyleSheet.create({
  page: { padding: 32, fontSize: 10, fontFamily: 'Helvetica' },
  name: { fontSize: 18, marginBottom: 2 },
  contactLine: { fontSize: 9, color: '#444444', marginBottom: 12 },
  sectionTitle: { fontSize: 12, marginTop: 12, marginBottom: 4, borderBottom: 1 },
  summary: { marginBottom: 8 },
  jobHeader: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  jobTitle: { fontWeight: 'bold' },
  jobDates: { color: '#444444' },
  bullet: { marginLeft: 10, marginTop: 2 },
  skillsLine: {},
  educationEntry: { marginTop: 4 },
});

/** Contact-info line: email, phone, location, and any non-null links, joined with ` · `. */
function contactLine(profile: Profile): string {
  return [
    profile.email,
    profile.phone,
    profile.location,
    profile.links.linkedin,
    profile.links.portfolio,
    profile.links.github,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' · ');
}

/**
 * The resume PDF layout: contact info + education from {@link Profile} (these don't vary per
 * job), summary/skills/work-experience from {@link TailoredResume} (these do).
 */
function ResumeDocument({ profile, tailoredResume }: { profile: Profile; tailoredResume: TailoredResume }) {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <Text style={styles.name}>{profile.fullName}</Text>
        <Text style={styles.contactLine}>{contactLine(profile)}</Text>

        <Text style={styles.summary}>{tailoredResume.summary}</Text>

        <Text style={styles.sectionTitle}>Skills</Text>
        <Text style={styles.skillsLine}>{tailoredResume.skills.join(', ')}</Text>

        <Text style={styles.sectionTitle}>Experience</Text>
        {tailoredResume.workExperience.map((job, i) => (
          <View key={i}>
            <View style={styles.jobHeader}>
              <Text style={styles.jobTitle}>
                {job.title}, {job.company}
              </Text>
              <Text style={styles.jobDates}>
                {job.startDate} – {job.endDate ?? 'Present'}
              </Text>
            </View>
            {job.bullets.map((bullet, j) => (
              <Text key={j} style={styles.bullet}>
                • {bullet}
              </Text>
            ))}
          </View>
        ))}

        {profile.education.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>Education</Text>
            {profile.education.map((edu, i) => (
              <Text key={i} style={styles.educationEntry}>
                {edu.degree}
                {edu.field ? `, ${edu.field}` : ''} — {edu.school}
                {edu.graduationYear ? ` (${edu.graduationYear})` : ''}
              </Text>
            ))}
          </>
        )}
      </Page>
    </Document>
  );
}

/**
 * Renders a resume PDF: contact info and education come from the base `profile` (they don't need
 * per-job tailoring), summary/skills/work-experience come from `tailoredResume`.
 *
 * @returns The rendered PDF as a `Buffer`.
 */
export async function renderResumePdf(profile: Profile, tailoredResume: TailoredResume): Promise<Buffer> {
  return renderToBuffer(<ResumeDocument profile={profile} tailoredResume={tailoredResume} />);
}
