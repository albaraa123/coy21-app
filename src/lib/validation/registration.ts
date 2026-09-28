import { z } from 'zod';

export const personalInfoSchema = z
  .object({
    phone: z.string().min(6),
    country: z.string().min(1),
    nationality: z.string().min(1),
    birth_date: z.string().optional(),
    age_group: z.enum(['under_18', '18_24', '25_34', '35_44', '45_plus']).optional(),
    city: z.string().min(1),
    organization: z.string().optional(),
    field_of_work: z.string().min(1),
    preferred_language: z.enum(['ar', 'en']),
  })
  .refine((data) => Boolean(data.birth_date) || Boolean(data.age_group), {
    message: 'Either birth_date or age_group is required',
    path: ['birth_date'],
  });

export const conferenceInfoSchema = z.object({
  interests: z.array(z.string()).min(1),
  climate_experience: z.string().optional(),
  experience_level: z.enum(['none', 'beginner', 'intermediate', 'expert']),
  past_initiatives: z.string().optional(),
  participation_goals: z.string().min(1),
  topics_to_learn: z.string().optional(),
  content_type_pref: z.string().optional(),
  track_interests: z.array(z.string()).optional(),
  priority_sessions: z.string().optional(),
  special_needs: z.string().optional(),
});

export const registrationSchema = personalInfoSchema.and(conferenceInfoSchema);
