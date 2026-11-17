from rest_framework import serializers


class DealSerializer(serializers.Serializer):
    id = serializers.IntegerField(read_only=True)
    title = serializers.CharField()
    status = serializers.ChoiceField(choices=['requested', 'approved', 'rejected', 'expired'])
    price = serializers.DecimalField(max_digits=8, decimal_places=2, allow_null=True)
    currency = serializers.CharField()
