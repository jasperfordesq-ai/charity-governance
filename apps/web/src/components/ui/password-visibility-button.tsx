'use client';

import { Button } from '@heroui/react';
import { Eye, EyeOff } from 'lucide-react';

type PasswordVisibilityButtonProps = {
  isVisible: boolean;
  onPress: () => void;
  label?: string;
};

export function PasswordVisibilityButton({ isVisible, onPress, label }: PasswordVisibilityButtonProps) {
  const accessibleLabel = label ?? (isVisible ? 'Hide password' : 'Show password');

  return (
    <Button
      type="button"
      isIconOnly
      size="sm"
      radius="full"
      variant="light"
      className="h-8 min-w-8 text-gray-500 hover:text-gray-700 focus-visible:ring-2 focus-visible:ring-teal-primary/40 dark:text-gray-400 dark:hover:text-gray-200 dark:focus-visible:ring-teal-bright/40"
      aria-label={accessibleLabel}
      onPress={onPress}
    >
      {isVisible ? (
        <EyeOff className="h-5 w-5" aria-hidden="true" />
      ) : (
        <Eye className="h-5 w-5" aria-hidden="true" />
      )}
    </Button>
  );
}
