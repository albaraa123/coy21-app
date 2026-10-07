export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      allocation_alternatives: {
        Row: {
          allocation_assignment_id: string
          id: string
          rank: number
          session_id: string
          suitability_score: number
        }
        Insert: {
          allocation_assignment_id: string
          id?: string
          rank: number
          session_id: string
          suitability_score: number
        }
        Update: {
          allocation_assignment_id?: string
          id?: string
          rank?: number
          session_id?: string
          suitability_score?: number
        }
        Relationships: [
          {
            foreignKeyName: "allocation_alternatives_allocation_assignment_id_fkey"
            columns: ["allocation_assignment_id"]
            isOneToOne: false
            referencedRelation: "allocation_assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "allocation_alternatives_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      allocation_assignment_explanations: {
        Row: {
          allocation_assignment_id: string
          constraint_type: string
          detail: string
          id: string
          passed: boolean
        }
        Insert: {
          allocation_assignment_id: string
          constraint_type: string
          detail: string
          id?: string
          passed: boolean
        }
        Update: {
          allocation_assignment_id?: string
          constraint_type?: string
          detail?: string
          id?: string
          passed?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "allocation_assignment_explanation_allocation_assignment_id_fkey"
            columns: ["allocation_assignment_id"]
            isOneToOne: false
            referencedRelation: "allocation_assignments"
            referencedColumns: ["id"]
          },
        ]
      }
      allocation_assignments: {
        Row: {
          allocation_run_id: string
          application_id: string
          created_at: string
          id: string
          is_low_confidence: boolean
          is_mandatory_assignment: boolean
          is_manual_override: boolean
          overridden_by: string | null
          override_reason: string | null
          session_id: string
          status: string
          suitability_score: number
          time_slot_group_key: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          allocation_run_id: string
          application_id: string
          created_at?: string
          id?: string
          is_low_confidence?: boolean
          is_mandatory_assignment?: boolean
          is_manual_override?: boolean
          overridden_by?: string | null
          override_reason?: string | null
          session_id: string
          status?: string
          suitability_score: number
          time_slot_group_key: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          allocation_run_id?: string
          application_id?: string
          created_at?: string
          id?: string
          is_low_confidence?: boolean
          is_mandatory_assignment?: boolean
          is_manual_override?: boolean
          overridden_by?: string | null
          override_reason?: string | null
          session_id?: string
          status?: string
          suitability_score?: number
          time_slot_group_key?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "allocation_assignments_allocation_run_id_fkey"
            columns: ["allocation_run_id"]
            isOneToOne: false
            referencedRelation: "allocation_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "allocation_assignments_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "allocation_assignments_overridden_by_fkey"
            columns: ["overridden_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "allocation_assignments_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "allocation_assignments_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      allocation_issues: {
        Row: {
          allocation_run_id: string
          application_id: string | null
          created_at: string
          details: Json | null
          id: string
          issue_type: string
          session_id: string | null
        }
        Insert: {
          allocation_run_id: string
          application_id?: string | null
          created_at?: string
          details?: Json | null
          id?: string
          issue_type: string
          session_id?: string | null
        }
        Update: {
          allocation_run_id?: string
          application_id?: string | null
          created_at?: string
          details?: Json | null
          id?: string
          issue_type?: string
          session_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "allocation_issues_allocation_run_id_fkey"
            columns: ["allocation_run_id"]
            isOneToOne: false
            referencedRelation: "allocation_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "allocation_issues_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "allocation_issues_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      allocation_runs: {
        Row: {
          confirmed_at: string | null
          confirmed_by: string | null
          feature_extraction_run_id: string
          id: string
          run_at: string
          run_by: string | null
          status: string
        }
        Insert: {
          confirmed_at?: string | null
          confirmed_by?: string | null
          feature_extraction_run_id: string
          id?: string
          run_at?: string
          run_by?: string | null
          status?: string
        }
        Update: {
          confirmed_at?: string | null
          confirmed_by?: string | null
          feature_extraction_run_id?: string
          id?: string
          run_at?: string
          run_by?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "allocation_runs_confirmed_by_fkey"
            columns: ["confirmed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "allocation_runs_feature_extraction_run_id_fkey"
            columns: ["feature_extraction_run_id"]
            isOneToOne: false
            referencedRelation: "feature_extraction_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "allocation_runs_run_by_fkey"
            columns: ["run_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      application_accommodation: {
        Row: {
          application_id: string
          created_at: string
          hotel_name: string | null
          id: string
          location_note: string | null
          room_number: string | null
          updated_at: string
        }
        Insert: {
          application_id: string
          created_at?: string
          hotel_name?: string | null
          id?: string
          location_note?: string | null
          room_number?: string | null
          updated_at?: string
        }
        Update: {
          application_id?: string
          created_at?: string
          hotel_name?: string | null
          id?: string
          location_note?: string | null
          room_number?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "application_accommodation_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: true
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
        ]
      }
      application_answers: {
        Row: {
          application_id: string
          created_at: string
          id: string
          import_batch_id: string | null
          is_sensitive: boolean
          normalized_value: string | null
          question_key: string
          question_label: string | null
          raw_value: string
          section: string
          source: string
          updated_at: string
          value_type: string
        }
        Insert: {
          application_id: string
          created_at?: string
          id?: string
          import_batch_id?: string | null
          is_sensitive?: boolean
          normalized_value?: string | null
          question_key: string
          question_label?: string | null
          raw_value: string
          section?: string
          source?: string
          updated_at?: string
          value_type: string
        }
        Update: {
          application_id?: string
          created_at?: string
          id?: string
          import_batch_id?: string | null
          is_sensitive?: boolean
          normalized_value?: string | null
          question_key?: string
          question_label?: string | null
          raw_value?: string
          section?: string
          source?: string
          updated_at?: string
          value_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "application_answers_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "application_answers_import_batch_fkey"
            columns: ["import_batch_id"]
            isOneToOne: false
            referencedRelation: "import_batches"
            referencedColumns: ["id"]
          },
        ]
      }
      application_health_info: {
        Row: {
          accessibility_requirements: string | null
          accommodation_preference: string | null
          allergies: string | null
          application_id: string
          consent_given: boolean | null
          created_at: string
          cultural_or_religious_requirements: string | null
          dietary_requirements: string | null
          emergency_contact_name: string | null
          emergency_contact_phone: string | null
          emergency_contact_relationship: string | null
          emergency_medication: string | null
          medical_conditions: string | null
          updated_at: string
        }
        Insert: {
          accessibility_requirements?: string | null
          accommodation_preference?: string | null
          allergies?: string | null
          application_id: string
          consent_given?: boolean | null
          created_at?: string
          cultural_or_religious_requirements?: string | null
          dietary_requirements?: string | null
          emergency_contact_name?: string | null
          emergency_contact_phone?: string | null
          emergency_contact_relationship?: string | null
          emergency_medication?: string | null
          medical_conditions?: string | null
          updated_at?: string
        }
        Update: {
          accessibility_requirements?: string | null
          accommodation_preference?: string | null
          allergies?: string | null
          application_id?: string
          consent_given?: boolean | null
          created_at?: string
          cultural_or_religious_requirements?: string | null
          dietary_requirements?: string | null
          emergency_contact_name?: string | null
          emergency_contact_phone?: string | null
          emergency_contact_relationship?: string | null
          emergency_medication?: string | null
          medical_conditions?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "application_health_info_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: true
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
        ]
      }
      application_notes: {
        Row: {
          application_id: string
          author_id: string
          body: string
          created_at: string
          id: string
        }
        Insert: {
          application_id: string
          author_id: string
          body: string
          created_at?: string
          id?: string
        }
        Update: {
          application_id?: string
          author_id?: string
          body?: string
          created_at?: string
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "application_notes_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "application_notes_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      application_status_history: {
        Row: {
          application_id: string
          changed_by: string | null
          created_at: string
          id: string
          new_status: Database["public"]["Enums"]["application_status"]
          note: string | null
          old_status: Database["public"]["Enums"]["application_status"] | null
        }
        Insert: {
          application_id: string
          changed_by?: string | null
          created_at?: string
          id?: string
          new_status: Database["public"]["Enums"]["application_status"]
          note?: string | null
          old_status?: Database["public"]["Enums"]["application_status"] | null
        }
        Update: {
          application_id?: string
          changed_by?: string | null
          created_at?: string
          id?: string
          new_status?: Database["public"]["Enums"]["application_status"]
          note?: string | null
          old_status?: Database["public"]["Enums"]["application_status"] | null
        }
        Relationships: [
          {
            foreignKeyName: "application_status_history_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "application_status_history_changed_by_fkey"
            columns: ["changed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      application_travel_info: {
        Row: {
          application_id: string
          can_attend_without_full_support: boolean | null
          created_at: string
          departure_airport: string | null
          invitation_letter_required: boolean | null
          passport_birth_date: string | null
          passport_copy_url: string | null
          passport_expiry_date: string | null
          passport_full_name: string | null
          passport_full_name_ar: string | null
          passport_issue_date: string | null
          passport_photo_url: string | null
          passport_place_of_issue: string | null
          support_level_requested: string | null
          updated_at: string
          visa_required: boolean | null
        }
        Insert: {
          application_id: string
          can_attend_without_full_support?: boolean | null
          created_at?: string
          departure_airport?: string | null
          invitation_letter_required?: boolean | null
          passport_birth_date?: string | null
          passport_copy_url?: string | null
          passport_expiry_date?: string | null
          passport_full_name?: string | null
          passport_full_name_ar?: string | null
          passport_issue_date?: string | null
          passport_photo_url?: string | null
          passport_place_of_issue?: string | null
          support_level_requested?: string | null
          updated_at?: string
          visa_required?: boolean | null
        }
        Update: {
          application_id?: string
          can_attend_without_full_support?: boolean | null
          created_at?: string
          departure_airport?: string | null
          invitation_letter_required?: boolean | null
          passport_birth_date?: string | null
          passport_copy_url?: string | null
          passport_expiry_date?: string | null
          passport_full_name?: string | null
          passport_full_name_ar?: string | null
          passport_issue_date?: string | null
          passport_photo_url?: string | null
          passport_place_of_issue?: string | null
          support_level_requested?: string | null
          updated_at?: string
          visa_required?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "application_travel_info_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: true
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
        ]
      }
      applications: {
        Row: {
          age_group: string | null
          applicant_id: string | null
          application_number: string | null
          assigned_reviewer_id: string | null
          attendance_confirmation: Database["public"]["Enums"]["attendance_confirmation_status"]
          birth_date: string | null
          city: string | null
          climate_experience: string | null
          content_type_pref: string | null
          country: string | null
          created_at: string
          education_level: string | null
          experience_level: string | null
          field_of_work: string | null
          full_name: string | null
          funding_type: Database["public"]["Enums"]["funding_type"] | null
          gender: string | null
          id: string
          import_batch_id: string | null
          imported_email: string | null
          institution_or_workplace: string | null
          interests: string[] | null
          last_import_row_fingerprint: string | null
          linkedin_url: string | null
          nationality: string | null
          organization: string | null
          participant_type:
            | Database["public"]["Enums"]["participant_type"]
            | null
          participation_goals: string | null
          past_initiatives: string | null
          phone: string | null
          preferred_language: string | null
          primary_track: string | null
          priority_sessions: string | null
          secondary_track: string | null
          session_languages: string[] | null
          special_needs: string | null
          status: Database["public"]["Enums"]["application_status"]
          submitted_at: string | null
          topics_to_learn: string | null
          track_1_focus_areas: string[] | null
          track_2_focus_areas: string[] | null
          track_3_focus_areas: string[] | null
          track_interests: string[] | null
          updated_at: string
          whatsapp_number: string | null
        }
        Insert: {
          age_group?: string | null
          applicant_id?: string | null
          application_number?: string | null
          assigned_reviewer_id?: string | null
          attendance_confirmation?: Database["public"]["Enums"]["attendance_confirmation_status"]
          birth_date?: string | null
          city?: string | null
          climate_experience?: string | null
          content_type_pref?: string | null
          country?: string | null
          created_at?: string
          education_level?: string | null
          experience_level?: string | null
          field_of_work?: string | null
          full_name?: string | null
          funding_type?: Database["public"]["Enums"]["funding_type"] | null
          gender?: string | null
          id?: string
          import_batch_id?: string | null
          imported_email?: string | null
          institution_or_workplace?: string | null
          interests?: string[] | null
          last_import_row_fingerprint?: string | null
          linkedin_url?: string | null
          nationality?: string | null
          organization?: string | null
          participant_type?:
            | Database["public"]["Enums"]["participant_type"]
            | null
          participation_goals?: string | null
          past_initiatives?: string | null
          phone?: string | null
          preferred_language?: string | null
          primary_track?: string | null
          priority_sessions?: string | null
          secondary_track?: string | null
          session_languages?: string[] | null
          special_needs?: string | null
          status?: Database["public"]["Enums"]["application_status"]
          submitted_at?: string | null
          topics_to_learn?: string | null
          track_1_focus_areas?: string[] | null
          track_2_focus_areas?: string[] | null
          track_3_focus_areas?: string[] | null
          track_interests?: string[] | null
          updated_at?: string
          whatsapp_number?: string | null
        }
        Update: {
          age_group?: string | null
          applicant_id?: string | null
          application_number?: string | null
          assigned_reviewer_id?: string | null
          attendance_confirmation?: Database["public"]["Enums"]["attendance_confirmation_status"]
          birth_date?: string | null
          city?: string | null
          climate_experience?: string | null
          content_type_pref?: string | null
          country?: string | null
          created_at?: string
          education_level?: string | null
          experience_level?: string | null
          field_of_work?: string | null
          full_name?: string | null
          funding_type?: Database["public"]["Enums"]["funding_type"] | null
          gender?: string | null
          id?: string
          import_batch_id?: string | null
          imported_email?: string | null
          institution_or_workplace?: string | null
          interests?: string[] | null
          last_import_row_fingerprint?: string | null
          linkedin_url?: string | null
          nationality?: string | null
          organization?: string | null
          participant_type?:
            | Database["public"]["Enums"]["participant_type"]
            | null
          participation_goals?: string | null
          past_initiatives?: string | null
          phone?: string | null
          preferred_language?: string | null
          primary_track?: string | null
          priority_sessions?: string | null
          secondary_track?: string | null
          session_languages?: string[] | null
          special_needs?: string | null
          status?: Database["public"]["Enums"]["application_status"]
          submitted_at?: string | null
          topics_to_learn?: string | null
          track_1_focus_areas?: string[] | null
          track_2_focus_areas?: string[] | null
          track_3_focus_areas?: string[] | null
          track_interests?: string[] | null
          updated_at?: string
          whatsapp_number?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "applications_applicant_id_fkey"
            columns: ["applicant_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "applications_assigned_reviewer_id_fkey"
            columns: ["assigned_reviewer_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "applications_import_batch_fkey"
            columns: ["import_batch_id"]
            isOneToOne: false
            referencedRelation: "import_batches"
            referencedColumns: ["id"]
          },
        ]
      }
      attendance_records: {
        Row: {
          admitted_at: string
          application_id: string
          booking_id: string | null
          correction_reason: string | null
          created_at: string
          device_identifier: string | null
          entry_type: string
          id: string
          scanned_by: string
          session_id: string
          status: string
          superseded_attendance_id: string | null
          time_slot_group_key: string
        }
        Insert: {
          admitted_at?: string
          application_id: string
          booking_id?: string | null
          correction_reason?: string | null
          created_at?: string
          device_identifier?: string | null
          entry_type: string
          id?: string
          scanned_by: string
          session_id: string
          status?: string
          superseded_attendance_id?: string | null
          time_slot_group_key: string
        }
        Update: {
          admitted_at?: string
          application_id?: string
          booking_id?: string | null
          correction_reason?: string | null
          created_at?: string
          device_identifier?: string | null
          entry_type?: string
          id?: string
          scanned_by?: string
          session_id?: string
          status?: string
          superseded_attendance_id?: string | null
          time_slot_group_key?: string
        }
        Relationships: [
          {
            foreignKeyName: "attendance_records_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_records_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "session_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_records_scanned_by_fkey"
            columns: ["scanned_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_records_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_records_superseded_attendance_id_fkey"
            columns: ["superseded_attendance_id"]
            isOneToOne: false
            referencedRelation: "attendance_records"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          actor_id: string | null
          actor_type: Database["public"]["Enums"]["audit_actor_type"]
          created_at: string
          entity_id: string
          entity_type: string
          id: string
          metadata: Json | null
          new_values: Json | null
          old_values: Json | null
          request_id: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          actor_type?: Database["public"]["Enums"]["audit_actor_type"]
          created_at?: string
          entity_id: string
          entity_type: string
          id?: string
          metadata?: Json | null
          new_values?: Json | null
          old_values?: Json | null
          request_id?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          actor_type?: Database["public"]["Enums"]["audit_actor_type"]
          created_at?: string
          entity_id?: string
          entity_type?: string
          id?: string
          metadata?: Json | null
          new_values?: Json | null
          old_values?: Json | null
          request_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      cluster_memberships: {
        Row: {
          application_id: string
          cluster_id: string
          distance_to_centroid: number
          id: string
        }
        Insert: {
          application_id: string
          cluster_id: string
          distance_to_centroid: number
          id?: string
        }
        Update: {
          application_id?: string
          cluster_id?: string
          distance_to_centroid?: number
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "cluster_memberships_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cluster_memberships_cluster_id_fkey"
            columns: ["cluster_id"]
            isOneToOne: false
            referencedRelation: "clusters"
            referencedColumns: ["id"]
          },
        ]
      }
      clustering_runs: {
        Row: {
          feature_extraction_run_id: string
          id: string
          k: number
          random_seed: number
          run_at: string
          run_by: string | null
          status: string
        }
        Insert: {
          feature_extraction_run_id: string
          id?: string
          k: number
          random_seed: number
          run_at?: string
          run_by?: string | null
          status: string
        }
        Update: {
          feature_extraction_run_id?: string
          id?: string
          k?: number
          random_seed?: number
          run_at?: string
          run_by?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "clustering_runs_feature_extraction_run_id_fkey"
            columns: ["feature_extraction_run_id"]
            isOneToOne: false
            referencedRelation: "feature_extraction_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clustering_runs_run_by_fkey"
            columns: ["run_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      clusters: {
        Row: {
          centroid: Json
          clustering_run_id: string
          id: string
          label: string | null
          member_count: number
        }
        Insert: {
          centroid: Json
          clustering_run_id: string
          id?: string
          label?: string | null
          member_count?: number
        }
        Update: {
          centroid?: Json
          clustering_run_id?: string
          id?: string
          label?: string | null
          member_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "clusters_clustering_run_id_fkey"
            columns: ["clustering_run_id"]
            isOneToOne: false
            referencedRelation: "clustering_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      conference_days: {
        Row: {
          conference_date: string
          created_at: string
          display_order: number
          id: string
          is_active: boolean
          label_ar: string
          label_en: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          conference_date: string
          created_at?: string
          display_order: number
          id?: string
          is_active?: boolean
          label_ar: string
          label_en: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          conference_date?: string
          created_at?: string
          display_order?: number
          id?: string
          is_active?: boolean
          label_ar?: string
          label_en?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "conference_days_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      conference_settings: {
        Row: {
          global_booking_deadline: string | null
          id: boolean
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          global_booking_deadline?: string | null
          id?: boolean
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          global_booking_deadline?: string | null
          id?: boolean
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "conference_settings_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      diag_app_number_function_props: {
        Row: {
          captured_at: string
          lang: string | null
          proconfig: string[] | null
          proname: string | null
          proparallel: string | null
          prosecdef: boolean | null
          prosrc: string | null
          provolatile: string | null
        }
        Insert: {
          captured_at?: string
          lang?: string | null
          proconfig?: string[] | null
          proname?: string | null
          proparallel?: string | null
          prosecdef?: boolean | null
          prosrc?: string | null
          provolatile?: string | null
        }
        Update: {
          captured_at?: string
          lang?: string | null
          proconfig?: string[] | null
          proname?: string | null
          proparallel?: string | null
          prosecdef?: boolean | null
          prosrc?: string | null
          provolatile?: string | null
        }
        Relationships: []
      }
      diag_app_number_log: {
        Row: {
          call_index: number
          captured_at: string
          id: number
          layer: string
          value: string
        }
        Insert: {
          call_index: number
          captured_at?: string
          id?: number
          layer: string
          value: string
        }
        Update: {
          call_index?: number
          captured_at?: string
          id?: number
          layer?: string
          value?: string
        }
        Relationships: []
      }
      diag_app_number_seq_props: {
        Row: {
          captured_at: string
          increment_by: number | null
          is_called: boolean | null
          last_value: number | null
          seqname: string | null
          start_value: number | null
        }
        Insert: {
          captured_at?: string
          increment_by?: number | null
          is_called?: boolean | null
          last_value?: number | null
          seqname?: string | null
          start_value?: number | null
        }
        Update: {
          captured_at?: string
          increment_by?: number | null
          is_called?: boolean | null
          last_value?: number | null
          seqname?: string | null
          start_value?: number | null
        }
        Relationships: []
      }
      email_log: {
        Row: {
          application_id: string | null
          id: string
          sent_at: string
          status: string
          template: string
        }
        Insert: {
          application_id?: string | null
          id?: string
          sent_at?: string
          status: string
          template: string
        }
        Update: {
          application_id?: string | null
          id?: string
          sent_at?: string
          status?: string
          template?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_log_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
        ]
      }
      email_settings: {
        Row: {
          id: boolean
          sandbox_enabled: boolean
          sandbox_recipient_email: string | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          id?: boolean
          sandbox_enabled?: boolean
          sandbox_recipient_email?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          id?: boolean
          sandbox_enabled?: boolean
          sandbox_recipient_email?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "email_settings_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      emergency_contacts: {
        Row: {
          application_id: string
          created_at: string
          email: string | null
          id: string
          name: string
          phone: string
          relationship: string
          updated_at: string
        }
        Insert: {
          application_id: string
          created_at?: string
          email?: string | null
          id?: string
          name: string
          phone: string
          relationship: string
          updated_at?: string
        }
        Update: {
          application_id?: string
          created_at?: string
          email?: string | null
          id?: string
          name?: string
          phone?: string
          relationship?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "emergency_contacts_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
        ]
      }
      feature_extraction_rules: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          match_type: string
          match_value: string
          source_field: string
          tag_id: string
          updated_at: string
          updated_by: string | null
          version: number
          weight: number
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          match_type: string
          match_value: string
          source_field: string
          tag_id: string
          updated_at?: string
          updated_by?: string | null
          version: number
          weight: number
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          match_type?: string
          match_value?: string
          source_field?: string
          tag_id?: string
          updated_at?: string
          updated_by?: string | null
          version?: number
          weight?: number
        }
        Relationships: [
          {
            foreignKeyName: "feature_extraction_rules_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "tags"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feature_extraction_rules_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      feature_extraction_runs: {
        Row: {
          application_count: number
          id: string
          rules_version: number
          run_at: string
          run_by: string | null
        }
        Insert: {
          application_count: number
          id?: string
          rules_version: number
          run_at?: string
          run_by?: string | null
        }
        Update: {
          application_count?: number
          id?: string
          rules_version?: number
          run_at?: string
          run_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "feature_extraction_runs_run_by_fkey"
            columns: ["run_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      import_batches: {
        Row: {
          auto_process_cluster_k: number | null
          auto_process_downstream: boolean
          completed_at: string | null
          confirmed_at: string | null
          downstream_status: string | null
          duplicate_count: number
          error_count: number
          failure_reason: string | null
          file_checksum: string
          id: string
          inserted_count: number
          mapping_template_id: string | null
          next_chunk_offset: number
          original_filename: string
          processing_lock_expires_at: string | null
          processing_lock_token: string | null
          row_count: number | null
          sheet_name: string | null
          skipped_count: number
          status: string
          storage_path: string
          unique_identifier_column_index: number | null
          updated_count: number
          uploaded_at: string
          uploaded_by: string | null
          valid_count: number
          warning_count: number
        }
        Insert: {
          auto_process_cluster_k?: number | null
          auto_process_downstream?: boolean
          completed_at?: string | null
          confirmed_at?: string | null
          downstream_status?: string | null
          duplicate_count?: number
          error_count?: number
          failure_reason?: string | null
          file_checksum: string
          id?: string
          inserted_count?: number
          mapping_template_id?: string | null
          next_chunk_offset?: number
          original_filename: string
          processing_lock_expires_at?: string | null
          processing_lock_token?: string | null
          row_count?: number | null
          sheet_name?: string | null
          skipped_count?: number
          status?: string
          storage_path: string
          unique_identifier_column_index?: number | null
          updated_count?: number
          uploaded_at?: string
          uploaded_by?: string | null
          valid_count?: number
          warning_count?: number
        }
        Update: {
          auto_process_cluster_k?: number | null
          auto_process_downstream?: boolean
          completed_at?: string | null
          confirmed_at?: string | null
          downstream_status?: string | null
          duplicate_count?: number
          error_count?: number
          failure_reason?: string | null
          file_checksum?: string
          id?: string
          inserted_count?: number
          mapping_template_id?: string | null
          next_chunk_offset?: number
          original_filename?: string
          processing_lock_expires_at?: string | null
          processing_lock_token?: string | null
          row_count?: number | null
          sheet_name?: string | null
          skipped_count?: number
          status?: string
          storage_path?: string
          unique_identifier_column_index?: number | null
          updated_count?: number
          uploaded_at?: string
          uploaded_by?: string | null
          valid_count?: number
          warning_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "import_batches_mapping_template_id_fkey"
            columns: ["mapping_template_id"]
            isOneToOne: false
            referencedRelation: "import_mapping_templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_batches_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      import_column_mappings: {
        Row: {
          confidence: number | null
          id: string
          import_batch_id: string
          is_manual_override: boolean
          source_column_header: string
          source_column_index: number
          target_key: string | null
          target_kind: string
        }
        Insert: {
          confidence?: number | null
          id?: string
          import_batch_id: string
          is_manual_override?: boolean
          source_column_header: string
          source_column_index: number
          target_key?: string | null
          target_kind: string
        }
        Update: {
          confidence?: number | null
          id?: string
          import_batch_id?: string
          is_manual_override?: boolean
          source_column_header?: string
          source_column_index?: number
          target_key?: string | null
          target_kind?: string
        }
        Relationships: [
          {
            foreignKeyName: "import_column_mappings_import_batch_id_fkey"
            columns: ["import_batch_id"]
            isOneToOne: false
            referencedRelation: "import_batches"
            referencedColumns: ["id"]
          },
        ]
      }
      import_mapping_templates: {
        Row: {
          created_at: string
          created_by: string
          header_signature: string
          id: string
          last_used_at: string | null
          mappings: Json
          name: string
          original_headers: Json
          version: number
        }
        Insert: {
          created_at?: string
          created_by: string
          header_signature: string
          id?: string
          last_used_at?: string | null
          mappings: Json
          name: string
          original_headers: Json
          version?: number
        }
        Update: {
          created_at?: string
          created_by?: string
          header_signature?: string
          id?: string
          last_used_at?: string | null
          mappings?: Json
          name?: string
          original_headers?: Json
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "import_mapping_templates_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      import_rows: {
        Row: {
          action_taken: string | null
          claimed_update_approved: boolean
          destination_application_id: string | null
          duplicate_of_row_id: string | null
          duplicate_status: string | null
          errors: Json
          excel_row_number: number
          id: string
          import_batch_id: string
          normalized_row: Json | null
          participant_type:
            | Database["public"]["Enums"]["participant_type"]
            | null
          previous_answers_snapshot: Json | null
          previous_application_snapshot: Json | null
          previous_health_snapshot: Json | null
          previous_travel_snapshot: Json | null
          raw_row: Json
          row_fingerprint: string
          validation_status: string
          warnings: Json
        }
        Insert: {
          action_taken?: string | null
          claimed_update_approved?: boolean
          destination_application_id?: string | null
          duplicate_of_row_id?: string | null
          duplicate_status?: string | null
          errors?: Json
          excel_row_number: number
          id?: string
          import_batch_id: string
          normalized_row?: Json | null
          participant_type?:
            | Database["public"]["Enums"]["participant_type"]
            | null
          previous_answers_snapshot?: Json | null
          previous_application_snapshot?: Json | null
          previous_health_snapshot?: Json | null
          previous_travel_snapshot?: Json | null
          raw_row: Json
          row_fingerprint: string
          validation_status?: string
          warnings?: Json
        }
        Update: {
          action_taken?: string | null
          claimed_update_approved?: boolean
          destination_application_id?: string | null
          duplicate_of_row_id?: string | null
          duplicate_status?: string | null
          errors?: Json
          excel_row_number?: number
          id?: string
          import_batch_id?: string
          normalized_row?: Json | null
          participant_type?:
            | Database["public"]["Enums"]["participant_type"]
            | null
          previous_answers_snapshot?: Json | null
          previous_application_snapshot?: Json | null
          previous_health_snapshot?: Json | null
          previous_travel_snapshot?: Json | null
          raw_row?: Json
          row_fingerprint?: string
          validation_status?: string
          warnings?: Json
        }
        Relationships: [
          {
            foreignKeyName: "import_rows_destination_application_id_fkey"
            columns: ["destination_application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_rows_duplicate_of_row_id_fkey"
            columns: ["duplicate_of_row_id"]
            isOneToOne: false
            referencedRelation: "import_rows"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_rows_import_batch_id_fkey"
            columns: ["import_batch_id"]
            isOneToOne: false
            referencedRelation: "import_batches"
            referencedColumns: ["id"]
          },
        ]
      }
      local_info_images: {
        Row: {
          caption: string | null
          created_at: string
          id: string
          section_id: string | null
          sort_order: number
          storage_url: string
        }
        Insert: {
          caption?: string | null
          created_at?: string
          id?: string
          section_id?: string | null
          sort_order?: number
          storage_url: string
        }
        Update: {
          caption?: string | null
          created_at?: string
          id?: string
          section_id?: string | null
          sort_order?: number
          storage_url?: string
        }
        Relationships: [
          {
            foreignKeyName: "local_info_images_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "local_info_sections"
            referencedColumns: ["id"]
          },
        ]
      }
      local_info_items: {
        Row: {
          created_at: string
          id: string
          label: string
          section_id: string
          sort_order: number
          value: string
        }
        Insert: {
          created_at?: string
          id?: string
          label: string
          section_id: string
          sort_order?: number
          value: string
        }
        Update: {
          created_at?: string
          id?: string
          label?: string
          section_id?: string
          sort_order?: number
          value?: string
        }
        Relationships: [
          {
            foreignKeyName: "local_info_items_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "local_info_sections"
            referencedColumns: ["id"]
          },
        ]
      }
      local_info_sections: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          sort_order: number
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          sort_order?: number
          title: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          sort_order?: number
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      participant_account_provisioning: {
        Row: {
          account_created_at: string | null
          account_status: Database["public"]["Enums"]["provisioning_account_status"]
          application_id: string
          auth_user_id: string | null
          bounced_at: string | null
          created_at: string
          created_by: string | null
          delivered_at: string | null
          email_status: Database["public"]["Enums"]["provisioning_email_status"]
          last_attempt_at: string | null
          last_error_code: string | null
          last_error_message: string | null
          last_login_email_sent_at: string | null
          last_send_attempt_at: string | null
          login_email_send_count: number
          must_change_password: boolean
          normalized_email: string
          provisioning_attempt_count: number
          resend_email_id: string | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          account_created_at?: string | null
          account_status?: Database["public"]["Enums"]["provisioning_account_status"]
          application_id: string
          auth_user_id?: string | null
          bounced_at?: string | null
          created_at?: string
          created_by?: string | null
          delivered_at?: string | null
          email_status?: Database["public"]["Enums"]["provisioning_email_status"]
          last_attempt_at?: string | null
          last_error_code?: string | null
          last_error_message?: string | null
          last_login_email_sent_at?: string | null
          last_send_attempt_at?: string | null
          login_email_send_count?: number
          must_change_password?: boolean
          normalized_email: string
          provisioning_attempt_count?: number
          resend_email_id?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          account_created_at?: string | null
          account_status?: Database["public"]["Enums"]["provisioning_account_status"]
          application_id?: string
          auth_user_id?: string | null
          bounced_at?: string | null
          created_at?: string
          created_by?: string | null
          delivered_at?: string | null
          email_status?: Database["public"]["Enums"]["provisioning_email_status"]
          last_attempt_at?: string | null
          last_error_code?: string | null
          last_error_message?: string | null
          last_login_email_sent_at?: string | null
          last_send_attempt_at?: string | null
          login_email_send_count?: number
          must_change_password?: boolean
          normalized_email?: string
          provisioning_attempt_count?: number
          resend_email_id?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "participant_account_provisioning_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: true
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "participant_account_provisioning_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "participant_account_provisioning_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      participant_feature_snapshots: {
        Row: {
          application_id: string
          created_at: string
          feature_extraction_run_id: string
          id: string
          tag_id: string
          weight: number
        }
        Insert: {
          application_id: string
          created_at?: string
          feature_extraction_run_id: string
          id?: string
          tag_id: string
          weight: number
        }
        Update: {
          application_id?: string
          created_at?: string
          feature_extraction_run_id?: string
          id?: string
          tag_id?: string
          weight?: number
        }
        Relationships: [
          {
            foreignKeyName: "participant_feature_snapshots_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "participant_feature_snapshots_feature_extraction_run_id_fkey"
            columns: ["feature_extraction_run_id"]
            isOneToOne: false
            referencedRelation: "feature_extraction_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "participant_feature_snapshots_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "tags"
            referencedColumns: ["id"]
          },
        ]
      }
      participant_invitations: {
        Row: {
          accepted_at: string | null
          application_id: string
          id: string
          imported_email: string
          invited_user_id: string | null
          last_error: string | null
          resend_count: number
          revoked_at: string | null
          sent_at: string | null
          sent_by: string | null
          status: string
        }
        Insert: {
          accepted_at?: string | null
          application_id: string
          id?: string
          imported_email: string
          invited_user_id?: string | null
          last_error?: string | null
          resend_count?: number
          revoked_at?: string | null
          sent_at?: string | null
          sent_by?: string | null
          status?: string
        }
        Update: {
          accepted_at?: string | null
          application_id?: string
          id?: string
          imported_email?: string
          invited_user_id?: string | null
          last_error?: string | null
          resend_count?: number
          revoked_at?: string | null
          sent_at?: string | null
          sent_by?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "participant_invitations_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: true
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "participant_invitations_invited_user_id_fkey"
            columns: ["invited_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "participant_invitations_sent_by_fkey"
            columns: ["sent_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      people: {
        Row: {
          bio_ar: string | null
          bio_en: string | null
          created_at: string
          email: string | null
          full_name_ar: string
          full_name_en: string
          id: string
          is_active: boolean
          is_public: boolean
          linked_application_id: string | null
          linked_profile_id: string | null
          organization_ar: string | null
          organization_en: string | null
          phone: string | null
          photo_path: string | null
          title_ar: string | null
          title_en: string | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          bio_ar?: string | null
          bio_en?: string | null
          created_at?: string
          email?: string | null
          full_name_ar: string
          full_name_en: string
          id?: string
          is_active?: boolean
          is_public?: boolean
          linked_application_id?: string | null
          linked_profile_id?: string | null
          organization_ar?: string | null
          organization_en?: string | null
          phone?: string | null
          photo_path?: string | null
          title_ar?: string | null
          title_en?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          bio_ar?: string | null
          bio_en?: string | null
          created_at?: string
          email?: string | null
          full_name_ar?: string
          full_name_en?: string
          id?: string
          is_active?: boolean
          is_public?: boolean
          linked_application_id?: string | null
          linked_profile_id?: string | null
          organization_ar?: string | null
          organization_en?: string | null
          phone?: string | null
          photo_path?: string | null
          title_ar?: string | null
          title_en?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "people_linked_application_id_fkey"
            columns: ["linked_application_id"]
            isOneToOne: true
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "people_linked_profile_id_fkey"
            columns: ["linked_profile_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "people_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          email: string
          full_name: string
          id: string
          must_change_password: boolean
          role: Database["public"]["Enums"]["user_role"]
        }
        Insert: {
          created_at?: string
          email: string
          full_name: string
          id: string
          must_change_password?: boolean
          role?: Database["public"]["Enums"]["user_role"]
        }
        Update: {
          created_at?: string
          email?: string
          full_name?: string
          id?: string
          must_change_password?: boolean
          role?: Database["public"]["Enums"]["user_role"]
        }
        Relationships: []
      }
      qr_bulk_operation_batches: {
        Row: {
          closed_at: string | null
          created_at: string
          created_by_auth_user_id: string
          created_by_profile_id: string | null
          expires_at: string
          id: string
          intended_operation_type: string
          status: string
        }
        Insert: {
          closed_at?: string | null
          created_at?: string
          created_by_auth_user_id: string
          created_by_profile_id?: string | null
          expires_at: string
          id?: string
          intended_operation_type: string
          status?: string
        }
        Update: {
          closed_at?: string | null
          created_at?: string
          created_by_auth_user_id?: string
          created_by_profile_id?: string | null
          expires_at?: string
          id?: string
          intended_operation_type?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "qr_bulk_operation_batches_created_by_profile_id_fkey"
            columns: ["created_by_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      qr_credentials: {
        Row: {
          application_id: string
          created_at: string
          encryption_key_version: number | null
          id: string
          issuance_channel: string
          issuance_note: string | null
          issuance_reason_code: string | null
          issued_at: string
          issued_by: string | null
          reissue_channel: string | null
          reissue_note: string | null
          reissue_reason_code: string | null
          replaced_at: string | null
          replaced_by: string | null
          replaced_by_credential_id: string | null
          revocation_note: string | null
          revocation_reason_code: string | null
          revoked_at: string | null
          revoked_by: string | null
          status: string
          token_ciphertext: string | null
          token_hash: string
          token_version: number
        }
        Insert: {
          application_id: string
          created_at?: string
          encryption_key_version?: number | null
          id?: string
          issuance_channel: string
          issuance_note?: string | null
          issuance_reason_code?: string | null
          issued_at?: string
          issued_by?: string | null
          reissue_channel?: string | null
          reissue_note?: string | null
          reissue_reason_code?: string | null
          replaced_at?: string | null
          replaced_by?: string | null
          replaced_by_credential_id?: string | null
          revocation_note?: string | null
          revocation_reason_code?: string | null
          revoked_at?: string | null
          revoked_by?: string | null
          status: string
          token_ciphertext?: string | null
          token_hash: string
          token_version?: number
        }
        Update: {
          application_id?: string
          created_at?: string
          encryption_key_version?: number | null
          id?: string
          issuance_channel?: string
          issuance_note?: string | null
          issuance_reason_code?: string | null
          issued_at?: string
          issued_by?: string | null
          reissue_channel?: string | null
          reissue_note?: string | null
          reissue_reason_code?: string | null
          replaced_at?: string | null
          replaced_by?: string | null
          replaced_by_credential_id?: string | null
          revocation_note?: string | null
          revocation_reason_code?: string | null
          revoked_at?: string | null
          revoked_by?: string | null
          status?: string
          token_ciphertext?: string | null
          token_hash?: string
          token_version?: number
        }
        Relationships: [
          {
            foreignKeyName: "qr_credentials_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "qr_credentials_encryption_key_version_fkey"
            columns: ["encryption_key_version"]
            isOneToOne: false
            referencedRelation: "qr_encryption_key_registry"
            referencedColumns: ["key_version"]
          },
          {
            foreignKeyName: "qr_credentials_issued_by_fkey"
            columns: ["issued_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "qr_credentials_replaced_by_fkey"
            columns: ["replaced_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "qr_credentials_replacement_same_application_fkey"
            columns: ["replaced_by_credential_id", "application_id"]
            isOneToOne: false
            referencedRelation: "qr_credentials"
            referencedColumns: ["id", "application_id"]
          },
          {
            foreignKeyName: "qr_credentials_revoked_by_fkey"
            columns: ["revoked_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      qr_encryption_key_registry: {
        Row: {
          activated_at: string
          id: string
          key_version: number
          retired_at: string | null
          status: string
        }
        Insert: {
          activated_at?: string
          id?: string
          key_version: number
          retired_at?: string | null
          status: string
        }
        Update: {
          activated_at?: string
          id?: string
          key_version?: number
          retired_at?: string | null
          status?: string
        }
        Relationships: []
      }
      qr_lifecycle_operations: {
        Row: {
          application_id: string
          bulk_batch_id: string | null
          channel: string
          consumed_at: string | null
          created_at: string
          expected_current_credential_id: string | null
          expires_at: string
          finalization_fingerprint: string | null
          finalized_at: string | null
          id: string
          note: string | null
          operation_type: string
          reason_code: string | null
          request_key: string
          requested_by_auth_user_id: string
          requested_by_profile_id: string | null
          resulting_credential_id: string | null
          status: string
          terminal_reason_code: string | null
          terminal_related_credential_id: string | null
          terminal_retry_after_at: string | null
        }
        Insert: {
          application_id: string
          bulk_batch_id?: string | null
          channel: string
          consumed_at?: string | null
          created_at?: string
          expected_current_credential_id?: string | null
          expires_at: string
          finalization_fingerprint?: string | null
          finalized_at?: string | null
          id?: string
          note?: string | null
          operation_type: string
          reason_code?: string | null
          request_key: string
          requested_by_auth_user_id: string
          requested_by_profile_id?: string | null
          resulting_credential_id?: string | null
          status?: string
          terminal_reason_code?: string | null
          terminal_related_credential_id?: string | null
          terminal_retry_after_at?: string | null
        }
        Update: {
          application_id?: string
          bulk_batch_id?: string | null
          channel?: string
          consumed_at?: string | null
          created_at?: string
          expected_current_credential_id?: string | null
          expires_at?: string
          finalization_fingerprint?: string | null
          finalized_at?: string | null
          id?: string
          note?: string | null
          operation_type?: string
          reason_code?: string | null
          request_key?: string
          requested_by_auth_user_id?: string
          requested_by_profile_id?: string | null
          resulting_credential_id?: string | null
          status?: string
          terminal_reason_code?: string | null
          terminal_related_credential_id?: string | null
          terminal_retry_after_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "qr_lifecycle_operations_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "qr_lifecycle_operations_bulk_batch_id_fkey"
            columns: ["bulk_batch_id"]
            isOneToOne: false
            referencedRelation: "qr_bulk_operation_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "qr_lifecycle_operations_expected_credential_fkey"
            columns: ["expected_current_credential_id", "application_id"]
            isOneToOne: false
            referencedRelation: "qr_credentials"
            referencedColumns: ["id", "application_id"]
          },
          {
            foreignKeyName: "qr_lifecycle_operations_requested_by_profile_id_fkey"
            columns: ["requested_by_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "qr_lifecycle_operations_resulting_credential_fkey"
            columns: ["resulting_credential_id", "application_id"]
            isOneToOne: false
            referencedRelation: "qr_credentials"
            referencedColumns: ["id", "application_id"]
          },
          {
            foreignKeyName: "qr_lifecycle_operations_terminal_related_credential_fkey"
            columns: ["terminal_related_credential_id", "application_id"]
            isOneToOne: false
            referencedRelation: "qr_credentials"
            referencedColumns: ["id", "application_id"]
          },
        ]
      }
      resend_webhook_events: {
        Row: {
          event_type: string
          received_at: string
          resend_email_id: string | null
          svix_id: string
        }
        Insert: {
          event_type: string
          received_at?: string
          resend_email_id?: string | null
          svix_id: string
        }
        Update: {
          event_type?: string
          received_at?: string
          resend_email_id?: string | null
          svix_id?: string
        }
        Relationships: []
      }
      rooms: {
        Row: {
          capacity: number
          code: string
          created_at: string
          floor: string | null
          id: string
          is_accessible: boolean
          is_active: boolean
          location: string | null
          name_ar: string
          name_en: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          capacity: number
          code: string
          created_at?: string
          floor?: string | null
          id?: string
          is_accessible?: boolean
          is_active?: boolean
          location?: string | null
          name_ar: string
          name_en: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          capacity?: number
          code?: string
          created_at?: string
          floor?: string | null
          id?: string
          is_accessible?: boolean
          is_active?: boolean
          location?: string | null
          name_ar?: string
          name_en?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "rooms_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      scan_attempts: {
        Row: {
          application_id: string | null
          created_at: string
          device_identifier: string | null
          expires_at: string | null
          finalized_at: string | null
          id: string
          idempotency_key: string | null
          metadata: Json | null
          result: string
          resulting_attendance_id: string | null
          scan_fingerprint: string | null
          scanned_by: string
          session_id: string | null
        }
        Insert: {
          application_id?: string | null
          created_at?: string
          device_identifier?: string | null
          expires_at?: string | null
          finalized_at?: string | null
          id?: string
          idempotency_key?: string | null
          metadata?: Json | null
          result: string
          resulting_attendance_id?: string | null
          scan_fingerprint?: string | null
          scanned_by: string
          session_id?: string | null
        }
        Update: {
          application_id?: string | null
          created_at?: string
          device_identifier?: string | null
          expires_at?: string | null
          finalized_at?: string | null
          id?: string
          idempotency_key?: string | null
          metadata?: Json | null
          result?: string
          resulting_attendance_id?: string | null
          scan_fingerprint?: string | null
          scanned_by?: string
          session_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "scan_attempts_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scan_attempts_resulting_attendance_id_fkey"
            columns: ["resulting_attendance_id"]
            isOneToOne: false
            referencedRelation: "attendance_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scan_attempts_scanned_by_fkey"
            columns: ["scanned_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scan_attempts_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      scanner_assignments: {
        Row: {
          assigned_at: string
          assigned_by: string
          id: string
          is_active: boolean
          room_id: string | null
          scanner_user_id: string
          session_id: string | null
        }
        Insert: {
          assigned_at?: string
          assigned_by: string
          id?: string
          is_active?: boolean
          room_id?: string | null
          scanner_user_id: string
          session_id?: string | null
        }
        Update: {
          assigned_at?: string
          assigned_by?: string
          id?: string
          is_active?: boolean
          room_id?: string | null
          scanner_user_id?: string
          session_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "scanner_assignments_assigned_by_fkey"
            columns: ["assigned_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scanner_assignments_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scanner_assignments_scanner_user_id_fkey"
            columns: ["scanner_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scanner_assignments_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      schedule_change_events: {
        Row: {
          change_type: string
          detected_at: string
          id: string
          processed_at: string | null
          session_id: string
        }
        Insert: {
          change_type: string
          detected_at?: string
          id?: string
          processed_at?: string | null
          session_id: string
        }
        Update: {
          change_type?: string
          detected_at?: string
          id?: string
          processed_at?: string | null
          session_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "schedule_change_events_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      schedule_publication_draft_items: {
        Row: {
          application_id: string
          blocker_details: Json | null
          id: string
          override_reason: string | null
          reassigned_session_id: string | null
          resolution: string | null
          schedule_publication_draft_id: string
          verdict: string
        }
        Insert: {
          application_id: string
          blocker_details?: Json | null
          id?: string
          override_reason?: string | null
          reassigned_session_id?: string | null
          resolution?: string | null
          schedule_publication_draft_id: string
          verdict: string
        }
        Update: {
          application_id?: string
          blocker_details?: Json | null
          id?: string
          override_reason?: string | null
          reassigned_session_id?: string | null
          resolution?: string | null
          schedule_publication_draft_id?: string
          verdict?: string
        }
        Relationships: [
          {
            foreignKeyName: "schedule_publication_draft_it_schedule_publication_draft_i_fkey"
            columns: ["schedule_publication_draft_id"]
            isOneToOne: false
            referencedRelation: "schedule_publication_drafts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schedule_publication_draft_items_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schedule_publication_draft_items_reassigned_session_id_fkey"
            columns: ["reassigned_session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      schedule_publication_drafts: {
        Row: {
          allocation_run_id: string | null
          id: string
          source_fingerprint: string
          staged_at: string
          staged_by: string | null
          status: string
          triggered_by_change_event_ids: string[] | null
        }
        Insert: {
          allocation_run_id?: string | null
          id?: string
          source_fingerprint: string
          staged_at?: string
          staged_by?: string | null
          status?: string
          triggered_by_change_event_ids?: string[] | null
        }
        Update: {
          allocation_run_id?: string | null
          id?: string
          source_fingerprint?: string
          staged_at?: string
          staged_by?: string | null
          status?: string
          triggered_by_change_event_ids?: string[] | null
        }
        Relationships: [
          {
            foreignKeyName: "schedule_publication_drafts_allocation_run_id_fkey"
            columns: ["allocation_run_id"]
            isOneToOne: false
            referencedRelation: "allocation_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schedule_publication_drafts_staged_by_fkey"
            columns: ["staged_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      schedule_publication_items: {
        Row: {
          end_time: string | null
          explanation_summary: string | null
          gap_reason: string | null
          id: string
          is_mandatory: boolean
          item_status: string
          room_name_ar: string | null
          room_name_en: string | null
          schedule_publication_id: string
          session_id: string | null
          session_title_ar: string | null
          session_title_en: string | null
          speakers: Json
          start_time: string | null
          suitability_score: number | null
        }
        Insert: {
          end_time?: string | null
          explanation_summary?: string | null
          gap_reason?: string | null
          id?: string
          is_mandatory: boolean
          item_status?: string
          room_name_ar?: string | null
          room_name_en?: string | null
          schedule_publication_id: string
          session_id?: string | null
          session_title_ar?: string | null
          session_title_en?: string | null
          speakers?: Json
          start_time?: string | null
          suitability_score?: number | null
        }
        Update: {
          end_time?: string | null
          explanation_summary?: string | null
          gap_reason?: string | null
          id?: string
          is_mandatory?: boolean
          item_status?: string
          room_name_ar?: string | null
          room_name_en?: string | null
          schedule_publication_id?: string
          session_id?: string | null
          session_title_ar?: string | null
          session_title_en?: string | null
          speakers?: Json
          start_time?: string | null
          suitability_score?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "schedule_publication_items_schedule_publication_id_fkey"
            columns: ["schedule_publication_id"]
            isOneToOne: false
            referencedRelation: "schedule_publications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schedule_publication_items_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      schedule_publications: {
        Row: {
          allocation_run_id: string
          application_id: string
          id: string
          published_at: string
          published_by: string
          revision_number: number
          source_fingerprint: string
          status: string
        }
        Insert: {
          allocation_run_id: string
          application_id: string
          id?: string
          published_at?: string
          published_by: string
          revision_number: number
          source_fingerprint: string
          status: string
        }
        Update: {
          allocation_run_id?: string
          application_id?: string
          id?: string
          published_at?: string
          published_by?: string
          revision_number?: number
          source_fingerprint?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "schedule_publications_allocation_run_id_fkey"
            columns: ["allocation_run_id"]
            isOneToOne: false
            referencedRelation: "allocation_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schedule_publications_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schedule_publications_published_by_fkey"
            columns: ["published_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      session_bookings: {
        Row: {
          application_id: string
          booked_at: string
          cancelled_at: string | null
          created_at: string
          id: string
          session_id: string
          source: string
          status: Database["public"]["Enums"]["booking_status"]
          updated_at: string
        }
        Insert: {
          application_id: string
          booked_at?: string
          cancelled_at?: string | null
          created_at?: string
          id?: string
          session_id: string
          source?: string
          status?: Database["public"]["Enums"]["booking_status"]
          updated_at?: string
        }
        Update: {
          application_id?: string
          booked_at?: string
          cancelled_at?: string | null
          created_at?: string
          id?: string
          session_id?: string
          source?: string
          status?: Database["public"]["Enums"]["booking_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_bookings_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_bookings_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      session_notification_outbox: {
        Row: {
          application_id: string
          booking_id: string
          created_at: string
          error_message: string | null
          id: string
          new_start_time: string | null
          notification_type: Database["public"]["Enums"]["session_notification_type"]
          old_start_time: string | null
          sent_at: string | null
          session_id: string
          status: Database["public"]["Enums"]["session_notification_status"]
        }
        Insert: {
          application_id: string
          booking_id: string
          created_at?: string
          error_message?: string | null
          id?: string
          new_start_time?: string | null
          notification_type: Database["public"]["Enums"]["session_notification_type"]
          old_start_time?: string | null
          sent_at?: string | null
          session_id: string
          status?: Database["public"]["Enums"]["session_notification_status"]
        }
        Update: {
          application_id?: string
          booking_id?: string
          created_at?: string
          error_message?: string | null
          id?: string
          new_start_time?: string | null
          notification_type?: Database["public"]["Enums"]["session_notification_type"]
          old_start_time?: string | null
          sent_at?: string | null
          session_id?: string
          status?: Database["public"]["Enums"]["session_notification_status"]
        }
        Relationships: [
          {
            foreignKeyName: "session_notification_outbox_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_notification_outbox_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "session_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_notification_outbox_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      session_people: {
        Row: {
          created_at: string
          display_order: number
          id: string
          is_primary: boolean
          person_id: string
          role: Database["public"]["Enums"]["session_person_role"]
          session_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          display_order?: number
          id?: string
          is_primary?: boolean
          person_id: string
          role: Database["public"]["Enums"]["session_person_role"]
          session_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          display_order?: number
          id?: string
          is_primary?: boolean
          person_id?: string
          role?: Database["public"]["Enums"]["session_person_role"]
          session_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "session_people_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_people_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_people_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      session_tags: {
        Row: {
          created_at: string
          id: string
          session_id: string
          tag_id: string
          updated_at: string
          updated_by: string | null
          weight: number
        }
        Insert: {
          created_at?: string
          id?: string
          session_id: string
          tag_id: string
          updated_at?: string
          updated_by?: string | null
          weight: number
        }
        Update: {
          created_at?: string
          id?: string
          session_id?: string
          tag_id?: string
          updated_at?: string
          updated_by?: string | null
          weight?: number
        }
        Relationships: [
          {
            foreignKeyName: "session_tags_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_tags_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "tags"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_tags_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      session_types: {
        Row: {
          code: string
          created_at: string
          enable_waitlist: boolean
          id: string
          is_active: boolean
          name_ar: string
          name_en: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          code: string
          created_at?: string
          enable_waitlist?: boolean
          id?: string
          is_active?: boolean
          name_ar: string
          name_en: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          code?: string
          created_at?: string
          enable_waitlist?: boolean
          id?: string
          is_active?: boolean
          name_ar?: string
          name_en?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "session_types_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      session_waitlist: {
        Row: {
          application_id: string
          created_at: string
          id: string
          joined_at: string
          promoted_at: string | null
          session_id: string
          status: Database["public"]["Enums"]["waitlist_status"]
          updated_at: string
          withdrawn_at: string | null
        }
        Insert: {
          application_id: string
          created_at?: string
          id?: string
          joined_at?: string
          promoted_at?: string | null
          session_id: string
          status?: Database["public"]["Enums"]["waitlist_status"]
          updated_at?: string
          withdrawn_at?: string | null
        }
        Update: {
          application_id?: string
          created_at?: string
          id?: string
          joined_at?: string
          promoted_at?: string | null
          session_id?: string
          status?: Database["public"]["Enums"]["waitlist_status"]
          updated_at?: string
          withdrawn_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "session_waitlist_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_waitlist_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      sessions: {
        Row: {
          admission_policy: string
          allocation_priority: number
          booking_deadline: string | null
          cancellation_reason: string | null
          cancelled_at: string | null
          capacity: number
          checkin_closes_at: string | null
          checkin_opens_at: string | null
          conference_day_id: string
          confirmed_at: string | null
          created_at: string
          description_ar: string | null
          description_en: string | null
          difficulty_level: Database["public"]["Enums"]["session_difficulty"]
          enable_qr_checkin: boolean
          end_time: string
          flexible_entry_manual_override: boolean | null
          id: string
          include_in_allocation: boolean
          internal_notes: string | null
          is_mandatory: boolean
          is_public: boolean
          language: Database["public"]["Enums"]["session_language"]
          late_entry_cutoff_minutes: number | null
          min_capacity: number
          priority_release_at: string | null
          priority_release_minutes_before: number | null
          priority_seats: number | null
          published_at: string | null
          room_id: string
          session_code: string
          session_type_id: string
          start_time: string
          status: Database["public"]["Enums"]["session_status"]
          title_ar: string
          title_en: string
          track_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          admission_policy?: string
          allocation_priority?: number
          booking_deadline?: string | null
          cancellation_reason?: string | null
          cancelled_at?: string | null
          capacity: number
          checkin_closes_at?: string | null
          checkin_opens_at?: string | null
          conference_day_id: string
          confirmed_at?: string | null
          created_at?: string
          description_ar?: string | null
          description_en?: string | null
          difficulty_level: Database["public"]["Enums"]["session_difficulty"]
          enable_qr_checkin?: boolean
          end_time: string
          flexible_entry_manual_override?: boolean | null
          id?: string
          include_in_allocation?: boolean
          internal_notes?: string | null
          is_mandatory?: boolean
          is_public?: boolean
          language: Database["public"]["Enums"]["session_language"]
          late_entry_cutoff_minutes?: number | null
          min_capacity?: number
          priority_release_at?: string | null
          priority_release_minutes_before?: number | null
          priority_seats?: number | null
          published_at?: string | null
          room_id: string
          session_code: string
          session_type_id: string
          start_time: string
          status?: Database["public"]["Enums"]["session_status"]
          title_ar: string
          title_en: string
          track_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          admission_policy?: string
          allocation_priority?: number
          booking_deadline?: string | null
          cancellation_reason?: string | null
          cancelled_at?: string | null
          capacity?: number
          checkin_closes_at?: string | null
          checkin_opens_at?: string | null
          conference_day_id?: string
          confirmed_at?: string | null
          created_at?: string
          description_ar?: string | null
          description_en?: string | null
          difficulty_level?: Database["public"]["Enums"]["session_difficulty"]
          enable_qr_checkin?: boolean
          end_time?: string
          flexible_entry_manual_override?: boolean | null
          id?: string
          include_in_allocation?: boolean
          internal_notes?: string | null
          is_mandatory?: boolean
          is_public?: boolean
          language?: Database["public"]["Enums"]["session_language"]
          late_entry_cutoff_minutes?: number | null
          min_capacity?: number
          priority_release_at?: string | null
          priority_release_minutes_before?: number | null
          priority_seats?: number | null
          published_at?: string | null
          room_id?: string
          session_code?: string
          session_type_id?: string
          start_time?: string
          status?: Database["public"]["Enums"]["session_status"]
          title_ar?: string
          title_en?: string
          track_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sessions_conference_day_id_fkey"
            columns: ["conference_day_id"]
            isOneToOne: false
            referencedRelation: "conference_days"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sessions_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sessions_session_type_id_fkey"
            columns: ["session_type_id"]
            isOneToOne: false
            referencedRelation: "session_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sessions_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sessions_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_assignments: {
        Row: {
          assignment_type: Database["public"]["Enums"]["staff_assignment_type"]
          created_at: string
          created_by: string | null
          ends_at: string | null
          id: string
          label: string
          notes: string | null
          room_id: string | null
          session_id: string | null
          staff_id: string
          starts_at: string | null
        }
        Insert: {
          assignment_type?: Database["public"]["Enums"]["staff_assignment_type"]
          created_at?: string
          created_by?: string | null
          ends_at?: string | null
          id?: string
          label: string
          notes?: string | null
          room_id?: string | null
          session_id?: string | null
          staff_id: string
          starts_at?: string | null
        }
        Update: {
          assignment_type?: Database["public"]["Enums"]["staff_assignment_type"]
          created_at?: string
          created_by?: string | null
          ends_at?: string | null
          id?: string
          label?: string
          notes?: string | null
          room_id?: string | null
          session_id?: string | null
          staff_id?: string
          starts_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "staff_assignments_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_assignments_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_assignments_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_assignments_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      tags: {
        Row: {
          code: string
          created_at: string
          id: string
          is_active: boolean
          name_ar: string
          name_en: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          code: string
          created_at?: string
          id?: string
          is_active?: boolean
          name_ar: string
          name_en: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          code?: string
          created_at?: string
          id?: string
          is_active?: boolean
          name_ar?: string
          name_en?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tags_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      tracks: {
        Row: {
          code: string
          color: string | null
          created_at: string
          id: string
          is_active: boolean
          name_ar: string
          name_en: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          code: string
          color?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          name_ar: string
          name_en: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          code?: string
          color?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          name_ar?: string
          name_en?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tracks_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      travel_legs: {
        Row: {
          application_id: string
          arrival_airport: string | null
          arrival_datetime: string | null
          created_at: string
          departure_airport: string | null
          departure_datetime: string | null
          flight_number: string | null
          id: string
          leg_type: Database["public"]["Enums"]["travel_leg_type"]
          notes: string | null
          ticket_file_url: string | null
          updated_at: string
        }
        Insert: {
          application_id: string
          arrival_airport?: string | null
          arrival_datetime?: string | null
          created_at?: string
          departure_airport?: string | null
          departure_datetime?: string | null
          flight_number?: string | null
          id?: string
          leg_type: Database["public"]["Enums"]["travel_leg_type"]
          notes?: string | null
          ticket_file_url?: string | null
          updated_at?: string
        }
        Update: {
          application_id?: string
          arrival_airport?: string | null
          arrival_datetime?: string | null
          created_at?: string
          departure_airport?: string | null
          departure_datetime?: string | null
          flight_number?: string | null
          id?: string
          leg_type?: Database["public"]["Enums"]["travel_leg_type"]
          notes?: string | null
          ticket_file_url?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "travel_legs_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      __tsgk_find_root: {
        Args: { p_idx: number; p_parent: number[] }
        Returns: number
      }
      accept_application_and_issue_number: {
        Args: { p_application_id: string }
        Returns: string
      }
      admit_walk_in: {
        Args: { p_application_id: string; p_session_id: string }
        Returns: string
      }
      apply_import_row_transactional: {
        Args: {
          p_actor_id: string
          p_import_batch_id: string
          p_import_row_id: string
        }
        Returns: string
      }
      assign_session_person_transactional: {
        Args: {
          p_display_order: number
          p_is_primary: boolean
          p_person_id: string
          p_role: Database["public"]["Enums"]["session_person_role"]
          p_session_id: string
          p_updated_by: string
        }
        Returns: {
          created_at: string
          display_order: number
          id: string
          is_primary: boolean
          person_id: string
          role: Database["public"]["Enums"]["session_person_role"]
          session_id: string
          updated_at: string
          updated_by: string | null
        }
        SetofOptions: {
          from: "*"
          to: "session_people"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      book_session: {
        Args: { p_application_id: string; p_session_id: string }
        Returns: string
      }
      cancel_booking: {
        Args: { p_application_id: string; p_booking_id: string }
        Returns: undefined
      }
      claim_imported_application_transactional: {
        Args: { p_application_id: string; p_claiming_user_id: string }
        Returns: undefined
      }
      complete_qr_bulk_operation_batch_for_server: {
        Args: { p_batch_id: string }
        Returns: string
      }
      compute_publication_fingerprint: {
        Args: { p_allocation_run_id: string; p_change_event_ids: string[] }
        Returns: string
      }
      compute_qr_finalization_fingerprint: {
        Args: {
          p_credential_id: string
          p_encryption_key_version: number
          p_operation_type: string
          p_token_ciphertext: string
          p_token_hash: string
          p_token_version: number
        }
        Returns: string
      }
      compute_time_slot_group_key_for_session: {
        Args: { p_session_id: string }
        Returns: string
      }
      confirm_allocation_run_transactional: {
        Args: { p_confirmed_by: string; p_run_id: string }
        Returns: {
          confirmed_at: string | null
          confirmed_by: string | null
          feature_extraction_run_id: string
          id: string
          run_at: string
          run_by: string | null
          status: string
        }
        SetofOptions: {
          from: "*"
          to: "allocation_runs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      confirm_publication_transactional: {
        Args: { p_confirmed_by: string; p_draft_id: string }
        Returns: {
          allocation_run_id: string | null
          id: string
          source_fingerprint: string
          staged_at: string
          staged_by: string | null
          status: string
          triggered_by_change_event_ids: string[] | null
        }
        SetofOptions: {
          from: "*"
          to: "schedule_publication_drafts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      correct_attendance_transactional: {
        Args: {
          p_attendance_id: string
          p_corrected_by: string
          p_reason: string
        }
        Returns: {
          admitted_at: string
          application_id: string
          booking_id: string | null
          correction_reason: string | null
          created_at: string
          device_identifier: string | null
          entry_type: string
          id: string
          scanned_by: string
          session_id: string
          status: string
          superseded_attendance_id: string | null
          time_slot_group_key: string
        }
        SetofOptions: {
          from: "*"
          to: "attendance_records"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      count_distinct_travellers: { Args: never; Returns: number }
      create_qr_bulk_operation_batch_for_server: {
        Args: {
          p_intended_operation_type: string
          p_staff_auth_user_id: string
          p_staff_profile_id: string
        }
        Returns: string
      }
      current_user_role: {
        Args: never
        Returns: Database["public"]["Enums"]["user_role"]
      }
      diag_raw_nextval: { Args: never; Returns: number }
      discard_allocation_run_transactional: {
        Args: { p_run_id: string }
        Returns: {
          confirmed_at: string | null
          confirmed_by: string | null
          feature_extraction_run_id: string
          id: string
          run_at: string
          run_by: string | null
          status: string
        }
        SetofOptions: {
          from: "*"
          to: "allocation_runs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      finalize_qr_issuance_for_server: {
        Args: {
          p_credential_id: string
          p_encryption_key_version: number
          p_operation_id: string
          p_token_ciphertext: string
          p_token_hash: string
          p_token_version: number
        }
        Returns: Database["public"]["CompositeTypes"]["qr_credential_lifecycle_result"]
        SetofOptions: {
          from: "*"
          to: "qr_credential_lifecycle_result"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      finalize_qr_reissue_for_server: {
        Args: {
          p_new_credential_id: string
          p_new_encryption_key_version: number
          p_new_token_ciphertext: string
          p_new_token_hash: string
          p_new_token_version: number
          p_operation_id: string
        }
        Returns: Database["public"]["CompositeTypes"]["qr_credential_lifecycle_result"]
        SetofOptions: {
          from: "*"
          to: "qr_credential_lifecycle_result"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      is_encryption_key_version_active: {
        Args: { p_key_version: number }
        Returns: boolean
      }
      is_encryption_key_version_decryptable: {
        Args: { p_key_version: number }
        Returns: boolean
      }
      is_staff: { Args: never; Returns: boolean }
      join_waitlist: {
        Args: { p_application_id: string; p_session_id: string }
        Returns: string
      }
      leave_waitlist: {
        Args: { p_application_id: string; p_session_id: string }
        Returns: undefined
      }
      next_application_number: {
        Args: { p_type?: Database["public"]["Enums"]["participant_type"] }
        Returns: string
      }
      ops_dashboard_snapshot: {
        Args: never
        Returns: {
          capacity: number
          is_full: boolean
          is_near_full: boolean
          last_scan_at: string
          occupancy_pct: number
          occupied_count: number
          rejection_breakdown: Json
          rejection_count_30m: number
          room_name_ar: string
          room_name_en: string
          scanner_count: number
          session_id: string
          stale_scanner_count: number
          title_ar: string
          title_en: string
        }[]
      }
      override_allocation_assignment_transactional: {
        Args: {
          p_assignment_id: string
          p_new_session_id: string
          p_overridden_by: string
          p_override_reason: string
        }
        Returns: {
          allocation_run_id: string
          application_id: string
          created_at: string
          id: string
          is_low_confidence: boolean
          is_mandatory_assignment: boolean
          is_manual_override: boolean
          overridden_by: string | null
          override_reason: string | null
          session_id: string
          status: string
          suitability_score: number
          time_slot_group_key: string
          updated_at: string
          updated_by: string | null
        }
        SetofOptions: {
          from: "*"
          to: "allocation_assignments"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      process_session_no_shows: {
        Args: { p_session_id: string }
        Returns: undefined
      }
      promote_next_waitlist_candidate: {
        Args: { p_session_id: string }
        Returns: undefined
      }
      reassign_blocked_participant_transactional: {
        Args: {
          p_draft_item_id: string
          p_new_session_id: string
          p_reassigned_by: string
        }
        Returns: {
          application_id: string
          blocker_details: Json | null
          id: string
          override_reason: string | null
          reassigned_session_id: string | null
          resolution: string | null
          schedule_publication_draft_id: string
          verdict: string
        }
        SetofOptions: {
          from: "*"
          to: "schedule_publication_draft_items"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      record_schedule_change_event: {
        Args: { p_change_type: string; p_session_id: string }
        Returns: undefined
      }
      regenerate_application_number: {
        Args: { p_application_id: string }
        Returns: string
      }
      remove_session_person: {
        Args: { p_session_people_id: string }
        Returns: undefined
      }
      request_my_qr_issuance_transactional: {
        Args: { p_request_key: string }
        Returns: Database["public"]["CompositeTypes"]["qr_credential_lifecycle_result"]
        SetofOptions: {
          from: "*"
          to: "qr_credential_lifecycle_result"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      request_my_qr_issuance_transactional_internal: {
        Args: { p_pending_ttl: string; p_request_key: string }
        Returns: Database["public"]["CompositeTypes"]["qr_credential_lifecycle_result"]
        SetofOptions: {
          from: "*"
          to: "qr_credential_lifecycle_result"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      request_my_qr_reissue_transactional: {
        Args: {
          p_expected_current_credential_id: string
          p_reissue_note: string
          p_reissue_reason_code: string
          p_request_key: string
        }
        Returns: Database["public"]["CompositeTypes"]["qr_credential_lifecycle_result"]
        SetofOptions: {
          from: "*"
          to: "qr_credential_lifecycle_result"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      request_my_qr_reissue_transactional_internal: {
        Args: {
          p_expected_current_credential_id: string
          p_pending_ttl: string
          p_reissue_note: string
          p_reissue_reason_code: string
          p_request_key: string
        }
        Returns: Database["public"]["CompositeTypes"]["qr_credential_lifecycle_result"]
        SetofOptions: {
          from: "*"
          to: "qr_credential_lifecycle_result"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      request_staff_qr_issuance_transactional: {
        Args: {
          p_application_id: string
          p_bulk_batch_id?: string
          p_issuance_note: string
          p_issuance_reason_code: string
          p_request_key: string
        }
        Returns: Database["public"]["CompositeTypes"]["qr_credential_lifecycle_result"]
        SetofOptions: {
          from: "*"
          to: "qr_credential_lifecycle_result"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      request_staff_qr_issuance_transactional_internal: {
        Args: {
          p_application_id: string
          p_bulk_batch_id: string
          p_issuance_note: string
          p_issuance_reason_code: string
          p_pending_ttl: string
          p_request_key: string
        }
        Returns: Database["public"]["CompositeTypes"]["qr_credential_lifecycle_result"]
        SetofOptions: {
          from: "*"
          to: "qr_credential_lifecycle_result"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      request_staff_qr_reissue_transactional: {
        Args: {
          p_application_id: string
          p_bulk_batch_id?: string
          p_expected_current_credential_id: string
          p_reissue_note: string
          p_reissue_reason_code: string
          p_request_key: string
        }
        Returns: Database["public"]["CompositeTypes"]["qr_credential_lifecycle_result"]
        SetofOptions: {
          from: "*"
          to: "qr_credential_lifecycle_result"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      request_staff_qr_reissue_transactional_internal: {
        Args: {
          p_application_id: string
          p_bulk_batch_id: string
          p_expected_current_credential_id: string
          p_pending_ttl: string
          p_reissue_note: string
          p_reissue_reason_code: string
          p_request_key: string
        }
        Returns: Database["public"]["CompositeTypes"]["qr_credential_lifecycle_result"]
        SetofOptions: {
          from: "*"
          to: "qr_credential_lifecycle_result"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      reserve_or_reuse_qr_lifecycle_operation: {
        Args: {
          p_application_id: string
          p_bulk_batch_id: string
          p_channel: string
          p_expected_current_credential_id: string
          p_note: string
          p_operation_type: string
          p_reason_code: string
          p_request_key: string
          p_requester_auth_user_id: string
        }
        Returns: Record<string, unknown>
      }
      resolve_application_display_name: {
        Args: { p_applicant_id: string; p_application_full_name: string }
        Returns: string
      }
      resolve_blocking_qr_lifecycle_operation: {
        Args: {
          p_app: Database["public"]["Tables"]["applications"]["Row"]
          p_candidate: Database["public"]["Tables"]["qr_lifecycle_operations"]["Row"]
        }
        Returns: string
      }
      resolve_blocking_qr_lifecycle_reissue_operation: {
        Args: {
          p_app: Database["public"]["Tables"]["applications"]["Row"]
          p_candidate: Database["public"]["Tables"]["qr_lifecycle_operations"]["Row"]
        }
        Returns: string
      }
      resolve_blocking_qr_lifecycle_staff_issuance_operation: {
        Args: {
          p_app: Database["public"]["Tables"]["applications"]["Row"]
          p_candidate: Database["public"]["Tables"]["qr_lifecycle_operations"]["Row"]
        }
        Returns: string
      }
      resolve_blocking_qr_lifecycle_staff_reissue_operation: {
        Args: {
          p_app: Database["public"]["Tables"]["applications"]["Row"]
          p_candidate: Database["public"]["Tables"]["qr_lifecycle_operations"]["Row"]
        }
        Returns: string
      }
      resolve_change_event_session_ids: {
        Args: { p_change_event_ids: string[] }
        Returns: string[]
      }
      retire_encryption_key_version: {
        Args: { p_key_version: number }
        Returns: string
      }
      rollback_import_batch_transactional: {
        Args: { p_actor_id: string; p_batch_id: string }
        Returns: undefined
      }
      rotate_encryption_key_version_for_server: {
        Args: { p_new_key_version: number }
        Returns: string
      }
      scan_attempt_transactional: {
        Args: {
          p_application_id: string
          p_device_identifier: string
          p_idempotency_key?: string
          p_is_override_caller?: boolean
          p_scanned_by: string
          p_scanner_user_id?: string
          p_session_id: string
          p_time_slot_group_key: string
          p_token_hash?: string
        }
        Returns: {
          application_id: string | null
          created_at: string
          device_identifier: string | null
          expires_at: string | null
          finalized_at: string | null
          id: string
          idempotency_key: string | null
          metadata: Json | null
          result: string
          resulting_attendance_id: string | null
          scan_fingerprint: string | null
          scanned_by: string
          session_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "scan_attempts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      scan_qr_attempt_transactional: {
        Args: {
          p_device_identifier: string
          p_idempotency_key?: string
          p_is_override_caller?: boolean
          p_scanned_by: string
          p_scanner_user_id?: string
          p_session_id: string
          p_token_hash: string
        }
        Returns: {
          application_id: string | null
          created_at: string
          device_identifier: string | null
          expires_at: string | null
          finalized_at: string | null
          id: string
          idempotency_key: string | null
          metadata: Json | null
          result: string
          resulting_attendance_id: string | null
          scan_fingerprint: string | null
          scanned_by: string
          session_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "scan_attempts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      session_active_booking_count: {
        Args: { p_session_id: string }
        Returns: number
      }
      session_allocation_confirmed_counts: {
        Args: never
        Returns: {
          confirmed_count: number
          session_id: string
        }[]
      }
      session_effective_deadline: {
        Args: { p_session: Database["public"]["Tables"]["sessions"]["Row"] }
        Returns: string
      }
      session_effective_occupied_count: {
        Args: { p_session_id: string }
        Returns: number
      }
      stage_publication_transactional: {
        Args: {
          p_allocation_run_id: string
          p_change_event_ids: string[]
          p_staged_by: string
        }
        Returns: {
          allocation_run_id: string | null
          id: string
          source_fingerprint: string
          staged_at: string
          staged_by: string | null
          status: string
          triggered_by_change_event_ids: string[] | null
        }
        SetofOptions: {
          from: "*"
          to: "schedule_publication_drafts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      transfer_attendance_transactional: {
        Args: {
          p_attendance_id: string
          p_new_session_id: string
          p_new_time_slot_group_key: string
          p_reason: string
          p_transferred_by: string
        }
        Returns: {
          admitted_at: string
          application_id: string
          booking_id: string | null
          correction_reason: string | null
          created_at: string
          device_identifier: string | null
          entry_type: string
          id: string
          scanned_by: string
          session_id: string
          status: string
          superseded_attendance_id: string | null
          time_slot_group_key: string
        }
        SetofOptions: {
          from: "*"
          to: "attendance_records"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      update_session_and_assignments_transactional: {
        Args: {
          p_end_time: string
          p_id: string
          p_new_assignments: Json
          p_room_id: string
          p_start_time: string
          p_updated_by: string
        }
        Returns: {
          admission_policy: string
          allocation_priority: number
          booking_deadline: string | null
          cancellation_reason: string | null
          cancelled_at: string | null
          capacity: number
          checkin_closes_at: string | null
          checkin_opens_at: string | null
          conference_day_id: string
          confirmed_at: string | null
          created_at: string
          description_ar: string | null
          description_en: string | null
          difficulty_level: Database["public"]["Enums"]["session_difficulty"]
          enable_qr_checkin: boolean
          end_time: string
          flexible_entry_manual_override: boolean | null
          id: string
          include_in_allocation: boolean
          internal_notes: string | null
          is_mandatory: boolean
          is_public: boolean
          language: Database["public"]["Enums"]["session_language"]
          late_entry_cutoff_minutes: number | null
          min_capacity: number
          priority_release_at: string | null
          priority_release_minutes_before: number | null
          priority_seats: number | null
          published_at: string | null
          room_id: string
          session_code: string
          session_type_id: string
          start_time: string
          status: Database["public"]["Enums"]["session_status"]
          title_ar: string
          title_en: string
          track_id: string
          updated_at: string
          updated_by: string | null
        }
        SetofOptions: {
          from: "*"
          to: "sessions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      update_session_transactional: {
        Args: {
          p_allocation_priority: number
          p_capacity: number
          p_checkin_closes_at: string
          p_checkin_opens_at: string
          p_conference_day_id: string
          p_description_ar: string
          p_description_en: string
          p_difficulty_level: Database["public"]["Enums"]["session_difficulty"]
          p_enable_qr_checkin: boolean
          p_end_time: string
          p_id: string
          p_include_in_allocation: boolean
          p_internal_notes: string
          p_is_mandatory: boolean
          p_is_public: boolean
          p_language: Database["public"]["Enums"]["session_language"]
          p_min_capacity: number
          p_room_id: string
          p_session_code: string
          p_session_type_id: string
          p_start_time: string
          p_title_ar: string
          p_title_en: string
          p_track_id: string
          p_updated_by: string
        }
        Returns: {
          admission_policy: string
          allocation_priority: number
          booking_deadline: string | null
          cancellation_reason: string | null
          cancelled_at: string | null
          capacity: number
          checkin_closes_at: string | null
          checkin_opens_at: string | null
          conference_day_id: string
          confirmed_at: string | null
          created_at: string
          description_ar: string | null
          description_en: string | null
          difficulty_level: Database["public"]["Enums"]["session_difficulty"]
          enable_qr_checkin: boolean
          end_time: string
          flexible_entry_manual_override: boolean | null
          id: string
          include_in_allocation: boolean
          internal_notes: string | null
          is_mandatory: boolean
          is_public: boolean
          language: Database["public"]["Enums"]["session_language"]
          late_entry_cutoff_minutes: number | null
          min_capacity: number
          priority_release_at: string | null
          priority_release_minutes_before: number | null
          priority_seats: number | null
          published_at: string | null
          room_id: string
          session_code: string
          session_type_id: string
          start_time: string
          status: Database["public"]["Enums"]["session_status"]
          title_ar: string
          title_en: string
          track_id: string
          updated_at: string
          updated_by: string | null
        }
        SetofOptions: {
          from: "*"
          to: "sessions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
    }
    Enums: {
      application_status:
        | "draft"
        | "submitted"
        | "under_review"
        | "accepted"
        | "waitlisted"
        | "rejected"
        | "withdrawn"
      attendance_confirmation_status: "confirmed" | "not_confirmed" | "declined"
      audit_actor_type: "admin" | "system"
      booking_status: "active" | "cancelled" | "session_cancelled" | "no_show"
      funding_type: "self_funded" | "partially_funded" | "fully_funded"
      participant_type:
        | "delegate"
        | "volunteer"
        | "knowledge_partner"
        | "youngo"
        | "speaker"
      provisioning_account_status:
        | "no_account"
        | "account_created"
        | "password_change_required"
        | "active"
        | "existing_account"
        | "creation_failed"
        | "conflict"
      provisioning_email_status:
        | "not_sent"
        | "sending"
        | "sent"
        | "failed"
        | "delivered"
        | "bounced"
      session_difficulty:
        | "beginner"
        | "intermediate"
        | "advanced"
        | "all_levels"
      session_language: "ar" | "en" | "bilingual"
      session_notification_status: "pending" | "sent" | "failed"
      session_notification_type:
        | "session_cancelled"
        | "session_rescheduled"
        | "waitlist_promoted"
      session_person_role:
        | "speaker"
        | "guest"
        | "moderator"
        | "facilitator"
        | "trainer"
        | "session_lead"
      session_status:
        | "draft"
        | "published"
        | "confirmed"
        | "cancelled"
        | "completed"
      staff_assignment_type:
        | "scanning_gate"
        | "session_monitor"
        | "participant_care"
        | "data_monitoring"
        | "general"
      travel_leg_type: "outbound" | "return" | "connecting"
      user_role:
        | "participant"
        | "super_admin"
        | "registration_admission_manager"
        | "agenda_allocation_manager"
        | "communications_attendance_manager"
        | "travel_operations_staff"
        | "participant_care_staff"
        | "participants_communications_manager"
        | "program_attendance_manager"
        | "scanner_device"
        | "staff"
      waitlist_status: "waiting" | "promoted" | "withdrawn"
    }
    CompositeTypes: {
      qr_credential_lifecycle_result: {
        outcome: string | null
        credential_id: string | null
        status: string | null
        issued_at: string | null
        replaced_at: string | null
        revoked_at: string | null
        retry_after_seconds: number | null
        operation_id: string | null
      }
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      application_status: [
        "draft",
        "submitted",
        "under_review",
        "accepted",
        "waitlisted",
        "rejected",
        "withdrawn",
      ],
      attendance_confirmation_status: [
        "confirmed",
        "not_confirmed",
        "declined",
      ],
      audit_actor_type: ["admin", "system"],
      booking_status: ["active", "cancelled", "session_cancelled", "no_show"],
      funding_type: ["self_funded", "partially_funded", "fully_funded"],
      participant_type: [
        "delegate",
        "volunteer",
        "knowledge_partner",
        "youngo",
        "speaker",
      ],
      provisioning_account_status: [
        "no_account",
        "account_created",
        "password_change_required",
        "active",
        "existing_account",
        "creation_failed",
        "conflict",
      ],
      provisioning_email_status: [
        "not_sent",
        "sending",
        "sent",
        "failed",
        "delivered",
        "bounced",
      ],
      session_difficulty: [
        "beginner",
        "intermediate",
        "advanced",
        "all_levels",
      ],
      session_language: ["ar", "en", "bilingual"],
      session_notification_status: ["pending", "sent", "failed"],
      session_notification_type: [
        "session_cancelled",
        "session_rescheduled",
        "waitlist_promoted",
      ],
      session_person_role: [
        "speaker",
        "guest",
        "moderator",
        "facilitator",
        "trainer",
        "session_lead",
      ],
      session_status: [
        "draft",
        "published",
        "confirmed",
        "cancelled",
        "completed",
      ],
      staff_assignment_type: [
        "scanning_gate",
        "session_monitor",
        "participant_care",
        "data_monitoring",
        "general",
      ],
      travel_leg_type: ["outbound", "return", "connecting"],
      user_role: [
        "participant",
        "super_admin",
        "registration_admission_manager",
        "agenda_allocation_manager",
        "communications_attendance_manager",
        "travel_operations_staff",
        "participant_care_staff",
        "participants_communications_manager",
        "program_attendance_manager",
        "scanner_device",
        "staff",
      ],
      waitlist_status: ["waiting", "promoted", "withdrawn"],
    },
  },
} as const
