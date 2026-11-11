import { Icon, type IconProps } from "./Icon";

/** Material Symbols Rounded "remove": weight 400, 24px optical size. */
export function RemoveIcon(props: IconProps) {
	return (
		<Icon {...props}>
			<path d="M240-440q-17 0-28.5-11.5T200-480q0-17 11.5-28.5T240-520h480q17 0 28.5 11.5T760-480q0 17-11.5 28.5T720-440H240Z" />
		</Icon>
	);
}
