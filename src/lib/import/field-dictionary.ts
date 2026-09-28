// src/lib/import/field-dictionary.ts
// Fixed dictionary of known applications/application_travel_info/
// application_health_info columns and application_answers question_keys,
// each with English + Arabic header aliases used for similarity matching
// (mapping-suggestion.ts). Extending this list is the ONLY place new known
// fields need to be added — mapping-suggestion.ts itself has no hardcoded
// field names.
//
// Phase B note: aliases for the Phase B fields below use the exact Arabic
// and English wording supplied for the real RCOY MENA Google Form. Where a
// field wasn't part of that supplied wording, the alias is a reasonable
// placeholder pending a real exported response sheet — flagged inline.
// suggestMapping's normalizeHeader already strips leading section numbers
// ("3.1 " / "٣.١ "), trailing explanatory lines, and Arabic-Indic digits
// before matching, so aliases here are written as plain question text
// without numbering.
export interface KnownField {
  key: string;               // destination column name, or a stable question_key for generic/known answers
  // core_field: applications column. known_answer: application_answers row
  // (may or may not also have a dedicated column — see is_sensitive
  // handling in apply_import_row_transactional for the 4 keys redirected to
  // travel_field/health_field below). travel_field/health_field: a column
  // on application_travel_info/application_health_info respectively — never
  // written to applications or exposed through a generic applications
  // query.
  kind: 'core_field' | 'known_answer' | 'travel_field' | 'health_field';
  isCriticalIdentity: boolean; // email, unique-identifier candidates — never auto-mapped below the confidence floor
  aliases: string[];          // English + Arabic, lowercased, used for exact/substring/fuzzy match
}

export const KNOWN_FIELDS: KnownField[] = [
  // ------------------------------------------------------------------
  // Participant profile (design doc section 13.2, applications columns)
  // ------------------------------------------------------------------
  { key: 'full_name', kind: 'core_field', isCriticalIdentity: false, aliases: ['full name', 'name', 'الاسم الكامل', 'اسمك الكامل', 'الاسم'] },
  { key: 'email', kind: 'core_field', isCriticalIdentity: true, aliases: ['email', 'email address', 'e-mail', "applicant's email address", 'email confirmation', 'البريد الإلكتروني', 'البريد الإلكتروني للمتقدم', 'تأكيد البريد الإلكتروني', 'الايميل'] },
  { key: 'phone', kind: 'core_field', isCriticalIdentity: false, aliases: ['phone', 'phone number', 'mobile', 'رقم الهاتف', 'الهاتف'] },
  { key: 'whatsapp_number', kind: 'core_field', isCriticalIdentity: false, aliases: ['whatsapp number (including country code)', 'whatsapp number', 'whatsapp', 'رقم الواتساب مع مقدمة الدولة', 'رقم الواتساب'] },
  { key: 'country', kind: 'core_field', isCriticalIdentity: false, aliases: ['country of residence', 'country', 'دولة الإقامة', 'الدولة', 'البلد'] },
  { key: 'nationality', kind: 'core_field', isCriticalIdentity: false, aliases: ['nationality', 'الجنسية'] },
  { key: 'city', kind: 'core_field', isCriticalIdentity: false, aliases: ['city of residence', 'city', 'مدينة السكن', 'المدينة'] },
  { key: 'gender', kind: 'core_field', isCriticalIdentity: false, aliases: ['gender', 'الجنس'] },
  { key: 'birth_date', kind: 'core_field', isCriticalIdentity: false, aliases: ['date of birth', 'dob', 'birth date', 'تاريخ الميلاد'] },
  { key: 'age_group', kind: 'core_field', isCriticalIdentity: false, aliases: ['age', 'age group', 'العمر'] },
  { key: 'education_level', kind: 'core_field', isCriticalIdentity: false, aliases: ['educational level', 'education level', 'المستوى الدراسي'] },
  { key: 'institution_or_workplace', kind: 'core_field', isCriticalIdentity: false, aliases: ['educational institution or workplace', 'institution or workplace', 'جهة الدراسة أو العمل'] },
  { key: 'field_of_work', kind: 'core_field', isCriticalIdentity: false, aliases: ['specialization', 'position', 'role', 'field of work', 'التخصص', 'المجال', 'الوظيفة'] },
  { key: 'preferred_language', kind: 'core_field', isCriticalIdentity: false, aliases: ['preferred communication language', 'preferred language', 'language', 'لغة التواصل المفضلة', 'اللغة المفضلة'] },
  { key: 'linkedin_url', kind: 'core_field', isCriticalIdentity: false, aliases: ['linkedin', 'linkedin or professional portfolio', 'portfolio', 'لينكدإن', 'لينكدإن أو الملف المهني'] },
  { key: 'primary_track', kind: 'core_field', isCriticalIdentity: false, aliases: ['primary track', 'المحور الرئيسي'] },
  { key: 'secondary_track', kind: 'core_field', isCriticalIdentity: false, aliases: ['secondary track', 'المحور الثانوي'] },
  { key: 'participant_type', kind: 'core_field', isCriticalIdentity: false, aliases: ['participant type', 'type', 'role', 'attendee type', 'delegate type', 'نوع المشارك', 'نوع المتقدم', 'فئة المشارك'] },
  { key: 'funding_type', kind: 'core_field', isCriticalIdentity: false, aliases: ['funding type', 'funding', 'sponsorship', 'support level', 'نوع التمويل', 'التمويل'] },
  { key: 'attendance_confirmation', kind: 'core_field', isCriticalIdentity: false, aliases: ['attendance confirmation', 'attendance', 'confirmation status', 'تأكيد الحضور', 'الحضور'] },

  // ------------------------------------------------------------------
  // Structured allocation columns (approved decision #2 — first-class
  // applications columns, never open-ended application_answers reads)
  // ------------------------------------------------------------------
  { key: 'session_languages', kind: 'core_field', isCriticalIdentity: false, aliases: ['languages you can use during the conference sessions', 'session languages', 'languages usable during conference sessions', 'اللغات التي يمكنك استخدامها خلال جلسات المؤتمر'] },
  // Aliases include both the current official track names (per the track
  // terminology correction) and the earlier wording this dictionary
  // originally shipped with ("...human well-being" / "...inclusive
  // leadership") — the old wording is kept indefinitely as a header alias so
  // sheets exported before the correction still auto-map correctly.
  { key: 'track_1_focus_areas', kind: 'core_field', isCriticalIdentity: false, aliases: ['track 1: adaptation, resilience, and resilient communities', 'track 1: adaptation, resilience, and human well-being', 'track 1 focus areas', 'المحور الأول: التكيف والمرونة وصمود المجتمعات', 'المحور الأول: التكيف والمرونة والرفاه الإنساني'] },
  { key: 'track_2_focus_areas', kind: 'core_field', isCriticalIdentity: false, aliases: ['track 2: just transition, green economy, and climate innovation', 'track 2 focus areas', 'المحور الثاني: التحول العادل والاقتصاد الأخضر والابتكار المناخي'] },
  { key: 'track_3_focus_areas', kind: 'core_field', isCriticalIdentity: false, aliases: ['track 3: climate finance, governance, and international cooperation', 'track 3: climate finance, governance, and inclusive leadership', 'track 3 focus areas', 'المحور الثالث: تمويل المناخ والحوكمة والتعاون الدولي', 'المحور الثالث: التمويل المناخي والحوكمة والقيادة الشاملة'] },

  // ------------------------------------------------------------------
  // Application & evaluation answers (application_answers, known_answer —
  // placeholder aliases pending the real exported form, per design doc
  // section 13.12 point 3)
  // ------------------------------------------------------------------
  { key: 'language_ability', kind: 'known_answer', isCriticalIdentity: false, aliases: ['language ability', 'arabic english ability', 'إتقان اللغة'] },
  { key: 'organization', kind: 'known_answer', isCriticalIdentity: false, aliases: ['organization', 'organisation', 'company', 'الجهة', 'المنظمة'] },
  { key: 'organization_role', kind: 'known_answer', isCriticalIdentity: false, aliases: ['organization and current role', 'current role', 'الجهة والدور الحالي'] },
  { key: 'experience_level', kind: 'known_answer', isCriticalIdentity: false, aliases: ['experience level', 'experience', 'مستوى الخبرة'] },
  { key: 'interests', kind: 'known_answer', isCriticalIdentity: false, aliases: ['climate and environmental interest areas', 'interests', 'climate interests', 'مجالات الاهتمام البيئي', 'الاهتمامات'] },
  { key: 'topics_to_learn', kind: 'known_answer', isCriticalIdentity: false, aliases: ['topics to learn', 'preferred topics', 'الموضوعات المفضلة'] },
  { key: 'volunteer_experience_years', kind: 'known_answer', isCriticalIdentity: false, aliases: ['years of volunteer or environmental experience', 'volunteer experience years', 'سنوات الخبرة التطوعية/البيئية'] },
  { key: 'previous_conference_participation', kind: 'known_answer', isCriticalIdentity: false, aliases: ['previous conference or initiative participation', 'previous participation', 'المشاركة السابقة في مؤتمرات/مبادرات'] },
  { key: 'initiative_or_organization_name', kind: 'known_answer', isCriticalIdentity: false, aliases: ['initiative or organization name', 'اسم المبادرة أو الجهة'] },
  { key: 'personal_introduction', kind: 'known_answer', isCriticalIdentity: false, aliases: ['personal introduction', 'نبذة شخصية'] },
  { key: 'significant_achievement', kind: 'known_answer', isCriticalIdentity: false, aliases: ['significant environmental achievement', 'most significant achievement', 'أبرز إنجاز بيئي'] },
  { key: 'reason_for_joining', kind: 'known_answer', isCriticalIdentity: false, aliases: ['reason for joining rcoy', 'سبب الانضمام لـ rcoy', 'سبب الانضمام'] },
  { key: 'expected_contribution', kind: 'known_answer', isCriticalIdentity: false, aliases: ['expected contribution', 'المساهمة المتوقعة'] },
  { key: 'expected_skills_experiences', kind: 'known_answer', isCriticalIdentity: false, aliases: ['skills or experiences expected', 'expected skills and experiences', 'المهارات/الخبرات المتوقع اكتسابها'] },
  { key: 'community_impact_plan', kind: 'known_answer', isCriticalIdentity: false, aliases: ['community impact plan', 'خطة الأثر المجتمعي'] },

  // ------------------------------------------------------------------
  // Travel/visa (application_travel_info — RLS-restricted to
  // travel_operations_staff/super_admin, never exposed through applications
  // or application_answers). Placeholder aliases pending the real form.
  // ------------------------------------------------------------------
  { key: 'support_level_requested', kind: 'travel_field', isCriticalIdentity: false, aliases: ['requested support level', 'مستوى الدعم المطلوب'] },
  { key: 'can_attend_without_full_support', kind: 'travel_field', isCriticalIdentity: false, aliases: ['able to attend without full support', 'ability to participate without full support', 'القدرة على الحضور بدون دعم كامل'] },
  { key: 'departure_airport', kind: 'travel_field', isCriticalIdentity: false, aliases: ['departure airport', 'departure airport, city, and country', 'مطار المغادرة'] },
  { key: 'visa_required', kind: 'travel_field', isCriticalIdentity: false, aliases: ['visa required', 'visa requirement', 'يتطلب تأشيرة'] },
  { key: 'invitation_letter_required', kind: 'travel_field', isCriticalIdentity: false, aliases: ['stamped invitation letter required', 'invitation letter required', 'يتطلب خطاب دعوة مختوم'] },
  { key: 'passport_full_name', kind: 'travel_field', isCriticalIdentity: false, aliases: ['full passport name (english)', 'passport full name english', 'الاسم الكامل في جواز السفر إنجليزي'] },
  { key: 'passport_full_name_ar', kind: 'travel_field', isCriticalIdentity: false, aliases: ['full passport name (arabic)', 'passport full name arabic', 'الاسم الكامل في جواز السفر عربي'] },
  { key: 'passport_birth_date', kind: 'travel_field', isCriticalIdentity: false, aliases: ['date of birth (passport)', 'passport date of birth', 'تاريخ الميلاد (جواز السفر)'] },
  { key: 'passport_place_of_issue', kind: 'travel_field', isCriticalIdentity: false, aliases: ['passport place of issue', 'مكان إصدار جواز السفر'] },
  { key: 'passport_issue_date', kind: 'travel_field', isCriticalIdentity: false, aliases: ['passport issue date', 'تاريخ إصدار جواز السفر'] },
  { key: 'passport_expiry_date', kind: 'travel_field', isCriticalIdentity: false, aliases: ['passport expiry date', 'تاريخ انتهاء جواز السفر'] },
  { key: 'passport_copy_url', kind: 'travel_field', isCriticalIdentity: false, aliases: ['passport copy', 'صورة جواز السفر'] },
  { key: 'passport_photo_url', kind: 'travel_field', isCriticalIdentity: false, aliases: ['visa photograph', 'visa-style photograph', 'صورة شخصية للتأشيرة'] },

  // ------------------------------------------------------------------
  // Health/accessibility (application_health_info — RLS-restricted to
  // participant_care_staff/super_admin). These 4 keys previously targeted
  // application_answers directly (known_answer); Phase B redirects them to
  // the dedicated table. Placeholder aliases pending the real form.
  // ------------------------------------------------------------------
  { key: 'allergies', kind: 'health_field', isCriticalIdentity: false, aliases: ['allergy status and details', 'allergies', 'الحساسية وتفاصيلها'] },
  { key: 'medical_conditions', kind: 'health_field', isCriticalIdentity: false, aliases: ['medical conditions', 'الحالات الطبية'] },
  { key: 'emergency_medication', kind: 'health_field', isCriticalIdentity: false, aliases: ['emergency medication', 'أدوية الطوارئ'] },
  { key: 'accessibility_requirements', kind: 'health_field', isCriticalIdentity: false, aliases: ['disability or accessibility status and accommodations', 'accessibility', 'accessibility requirements', 'احتياجات الوصول'] },
  { key: 'dietary_requirements', kind: 'health_field', isCriticalIdentity: false, aliases: ['dietary requirements', 'dietary', 'food restrictions', 'المتطلبات الغذائية'] },
  { key: 'accommodation_preference', kind: 'health_field', isCriticalIdentity: false, aliases: ['accommodation preference', 'تفضيلات الإقامة'] },
  { key: 'cultural_or_religious_requirements', kind: 'health_field', isCriticalIdentity: false, aliases: ['religious, cultural, or organizational requirements', 'cultural or religious requirements', 'متطلبات دينية/ثقافية/تنظيمية'] },
  { key: 'emergency_contact_name', kind: 'health_field', isCriticalIdentity: false, aliases: ['emergency contact name', 'اسم جهة الاتصال للطوارئ'] },
  { key: 'emergency_contact_relationship', kind: 'health_field', isCriticalIdentity: false, aliases: ['emergency contact relationship', 'صلة القرابة بجهة اتصال الطوارئ'] },
  { key: 'emergency_contact_phone', kind: 'health_field', isCriticalIdentity: false, aliases: ['emergency contact phone', 'هاتف جهة اتصال الطوارئ'] },
  { key: 'consent_given', kind: 'health_field', isCriticalIdentity: false, aliases: ['consent', 'الموافقة'] },
];
