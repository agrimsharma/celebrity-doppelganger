{{- define "dopp.fullname" -}}
{{- .Release.Name | trunc 50 | trimSuffix "-" -}}
{{- end -}}

{{- define "dopp.labels" -}}
app.kubernetes.io/part-of: doppelganger
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "dopp.backendSelector" -}}
app.kubernetes.io/name: doppelganger-backend
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "dopp.frontendSelector" -}}
app.kubernetes.io/name: doppelganger-frontend
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
