import { describe, expect, it, jest } from '@jest/globals';
import { Text } from 'react-native';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { IconSelectGrid } from './IconSelectGrid';

describe('IconSelectGrid', () => {
  const items = [
    { key: 'scan', label: 'Scan Serial', icon: <Text>[scan-icon]</Text> },
    { key: 'use-part', label: 'Use Part', icon: <Text>[use-part-icon]</Text> },
    { key: 'request', label: 'Request', icon: <Text>[request-icon]</Text> },
  ];

  it('renders every item label and icon', () => {
    render(<IconSelectGrid items={items} onSelect={jest.fn()} />);

    expect(screen.getByText('Scan Serial')).toBeTruthy();
    expect(screen.getByText('Use Part')).toBeTruthy();
    expect(screen.getByText('Request')).toBeTruthy();
    expect(screen.getByText('[scan-icon]')).toBeTruthy();
  });

  it('calls onSelect with the pressed item key', () => {
    const onSelect = jest.fn();
    render(<IconSelectGrid items={items} onSelect={onSelect} />);

    fireEvent.press(screen.getByText('Use Part'));

    expect(onSelect).toHaveBeenCalledWith('use-part');
  });

  it('disables a specific item without dropping it from the grid', () => {
    const onSelect = jest.fn();
    render(
      <IconSelectGrid
        items={items}
        onSelect={onSelect}
        disabledKeys={['request']}
      />,
    );

    fireEvent.press(screen.getByText('Request'));

    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByText('Request')).toBeTruthy();
  });
});
